# augchatd — Spec da Fatia 2 (modo produção end-to-end)

**Data:** 2026-05-22
**Status:** Aprovado (brainstorming concluído)
**Documento pai:** `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md` (decisões transversais).
**Spec anterior:** `docs/superpowers/specs/2026-05-21-augchatd-fatia-1-mvp-demo-spec.md` (forma e contratos que esta fatia herda).
**Plano de implementação:** a ser gerado em `docs/superpowers/plans/2026-05-22-augchatd-fatia-2-producao.md`.
**Escopo deste documento:** congelar **o que** entrega a Fatia 2 — escopo, contratos externos novos/alterados, modelos de dados, critérios de aceite. **Não escopo:** ordem de implementação, código de exemplo, comandos shell (isso fica no plano).

---

## 1. Objetivo

Levar augchatd ao modo produção. O mesmo binário/imagem da Fatia 1 passa a aceitar `AUGCHATD_MODE=prod`, exigindo mTLS para o control plane (`POST /sessions`, `DELETE /sessions/{id}`), atendendo múltiplos tenants reais com SQLite hot dedicado por tenant, persistindo conversas em S3 cold via NDJSON por-conversa, e recuperando flushes pendentes através de boot scan. Demo mode (Fatia 1) continua funcionando inalterado no mesmo binário.

O que a Fatia 2 desbloqueia:
- A promessa principal do README — *"Two calls do everything: your backend → augchatd (mTLS) + embedded UI → augchatd (JWT)"* — passa a funcionar literalmente.
- Multi-tenancy operacional: vários backends podem provisionar sessões para usuários distintos dentro do mesmo processo augchatd, com isolamento lógico por SAN URI.
- Durabilidade: dados sobrevivem a kill do processo e wipe do volume hot, porque o cold tem cópia.
- Lifecycle de tenant: SQLite por tenant abre lazy, fecha em ociosidade longa, nunca é destruído automaticamente.

O que a Fatia 2 **não** quer provar: MCP (Fatia 3) e RAG (Fatia 4). O `SessionPayloadSchema` permanece estritamente o subset da Fatia 1 (mais o `storage.s3` estruturado); payloads contendo `mcp_servers` ou `tools.rag` são rejeitados com 400.

---

## 2. Escopo: o que entra

| Área | Decisão |
|---|---|
| Modo | `AUGCHATD_MODE=prod` ganha implementação. `demo` permanece funcionando inalterado no mesmo binário. |
| Topologia de portas | **Duas portas** no mesmo processo: `AUGCHATD_LISTEN_CONTROL` (mTLS obrigatório, só rotas `/sessions*` + `/health` + `/version`) + `AUGCHATD_LISTEN_DATA` (TLS opcional, UI + rotas JWT + `/health` + `/version`). Demo abre só a porta DATA. |
| mTLS | `AUGCHATD_TLS_CERT_FILE`, `AUGCHATD_TLS_KEY_FILE`, `AUGCHATD_CLIENT_CA_FILE` exigidos quando `mode=prod`. `rejectUnauthorized: true` na porta CONTROL. Extração de tenant_id por SAN URI: **exatamente um** SAN URI exigido — zero ou múltiplos → 400 `tenant_san_ambiguous`. |
| Control plane | `POST /sessions` valida payload via `SessionPayloadSchema` strict, executa smoke test S3, minta JWT, retorna `{session_id, jwt, expires_at}`. `DELETE /sessions/{id}` evicta entrada da memória; requests em voo finalizam. |
| Colisão de sessão | `POST /sessions` para `(tenant, user)` com sessão preexistente **adiciona** nova entrada. Sids são independentes; TTL natural drena os antigos. Sem dedup, sem auto-evict. |
| `SessionPayloadSchema` | Mesmo subset da Fatia 1 + `storage.s3` muda de string opaca para **objeto estruturado** (§5.3). Schema é `.strict()`: `mcp_servers`/`tools.rag` → 400 `unsupported_field`. |
| Storage S3 | Objeto estruturado: `{bucket, prefix?, region, endpoint?, access_key_id, secret_access_key, force_path_style?}`. Suporta S3-compatíveis (Spaces, MinIO, Backblaze) via `endpoint` + `force_path_style`. Smoke test em `POST /sessions` faz write→read→delete de objeto temporário; falha → 400 `storage_unreachable`. |
| Cold storage | NDJSON por conversa em `s3://<bucket>/<prefix><tenant_id>/<user_id>/<conversation_id>/{messages.ndjson, meta.json}`. PUT que **sobrescreve** o arquivo inteiro (não append). |
| Triggers de flush | Por conversa: (a) sessão que tocou a conversa evictada (TTL natural ou `DELETE /sessions/{id}`); OU (b) `AUGCHATD_FLUSH_IDLE_SECONDS` sem novas mensagens naquela conversa (default 300s). |
| Marcação de flush | Coluna `flushed_at` (já existente desde Fatia 1) preenchida no commit pós-PUT bem-sucedido, transação SQLite atômica cobrindo todas as rows da conversa. |
| GC do hot | Passe a cada 60s: rows com `flushed_at < now() - AUGCHATD_GC_DELAY_SECONDS` (default 60s) são deletadas. Conversas sem rows com `flushed_at IS NULL` ficam só como linha em `conversations` até DELETE explícito. |
| Falha de flush | Backoff exponencial (1s, 2s, 4s … cap `AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS` = 300s), log estruturado a cada tentativa. **Nunca dropa dado hot enquanto cold não confirma.** |
| Multi-tenant SQLite | Lazy open na primeira sessão do tenant (ou no boot recovery scan se já existe arquivo). Fecha após `AUGCHATD_TENANT_IDLE_CLOSE_SECONDS` (default 1800s) sem sessões ativas **E** sem flush pendente. Reabre lazy. Arquivo nunca é deletado pelo augchatd. |
| Boot recovery | Ao boot: varre `AUGCHATD_HOT_DIR/*.sqlite`. Para cada arquivo, identifica conversas com mensagens unflushed e enfileira-as como pendentes. **Não faz flush ativo** — aguarda uma sessão chegar para aquele tenant via `POST /sessions`; o flush usa as credenciais S3 da sessão recém-criada. Sem sessão, dado permanece hot indefinidamente (documentado). |
| Graceful shutdown | SIGTERM ou SIGINT: (1) para de aceitar novos requests em ambas as portas; (2) streams abertos terminam, deadline `AUGCHATD_SHUTDOWN_DEADLINE_SECONDS` (default 30s); (3) parciais não completas marcadas `stopped_by_shutdown=1`; (4) flush sincrônico de todo hot pendente cuja sessão correspondente esteja viva; (5) fecha SQLite, exit 0. Hot pendente sem sessão viva fica para próximo boot. |
| Observabilidade | Logs JSON existentes + eventos novos: `flush.start`, `flush.ok`, `flush.retry`, `flush.failed`, `tenant.open`, `tenant.close`, `session.created`, `session.evicted`, `recovery.scan`, `recovery.pending_found`. |
| Deploy | Dockerfile multi-stage inalterado; operador injeta cert/key/CA via volume mount ou k8s secret. |

---

## 3. Escopo: o que NÃO entra

- **MCP client** (Fatia 3). Schema continua rejeitando `mcp_servers`. Coluna `tool_calls` continua existindo mas sempre NULL.
- **RAG** (Fatia 4). Schema continua rejeitando `tools.rag`.
- **CSP `frame-ancestors` per-tenant**: permissivo, igual Fatia 1.
- **`/metrics` endpoint**: deferido (operador pluga sidecar OTel).
- **Hot reload de TLS ou JWT material**: restart-only (k8s/cert-manager rotacionam via pod restart).
- **Per-tenant rate limiting**: README declara fora do produto.
- **`DELETE /tenants/{id}`**: decomissionamento é manual (stop daemon + rm sqlite + s3 cleanup).
- **`/ready` separado de `/health`**: boot recovery é async; não bloqueia tráfego. `/health` permanece único.
- **Cache de smoke test S3**: cada `POST /sessions` paga o ~100ms do round trip. Sem dedup por `(bucket, creds)`.
- **`POST /sessions/{id}/jwt` ("renew leve")**: não existe; refresh = novo `POST /sessions`.
- **Cap de sessões por tenant ou por usuário**: sem hard limit. Memória/FDs são soft cap.
- **Encryption client-side antes do PUT em S3**: operador configura SSE-S3/SSE-KMS no bucket. Augchatd assume bucket configurado.
- **Recuperação de flush quando o bucket S3 do tenant mudou entre boots**: novo session config define novo destino; hot pendente vai para o novo. Conflito não é detectado — operador é responsável.
- **`bun build --compile` single-binary**: continua não bloqueante; Docker é suficiente.

---

## 4. Contratos externos

Tudo nesta seção é **público e congelado** ao fim da Fatia 2. Mudanças quebram backends operadores ou a UI bundled. Trocas de forma exigem revisão explícita.

### 4.1 Variáveis de ambiente

#### 4.1.1 Process-level (`AUGCHATD_*`)

| Variável | Obrigatória | Default | Validação / Notas |
|---|---|---|---|
| `AUGCHATD_MODE` | não | `demo` | `demo` ou `prod`. Em `prod`, vars TLS abaixo passam a ser obrigatórias. |
| `AUGCHATD_LISTEN_DATA` | não | `0.0.0.0:8080` | porta data plane (UI + JWT). **Renomeada** do `AUGCHATD_LISTEN` da Fatia 1 — sem alias retrocompatível (Fatia 1 não está em produção; rename limpo). |
| `AUGCHATD_LISTEN_CONTROL` | não em demo, **sim em prod** | — | porta control plane (mTLS). Tipicamente `0.0.0.0:8443`. Ignorada quando `mode=demo` (e logado se presente). |
| `AUGCHATD_TLS_CERT_FILE` | só em prod | — | path PEM do cert do servidor para a porta CONTROL. Lido na inicialização. |
| `AUGCHATD_TLS_KEY_FILE` | só em prod | — | path PEM da chave privada. |
| `AUGCHATD_CLIENT_CA_FILE` | só em prod | — | bundle PEM de CAs que assinam certs de cliente válidos. Múltiplas CAs concatenadas no mesmo arquivo são aceitas. |
| `AUGCHATD_DATA_TLS_CERT_FILE` | não | — | opcional; cert TLS para a porta DATA (TLS server-only, sem client cert). Sem essa var, DATA serve plain HTTP (deploy típico termina TLS num LB). |
| `AUGCHATD_DATA_TLS_KEY_FILE` | não | — | par com `AUGCHATD_DATA_TLS_CERT_FILE`. Se uma estiver definida, a outra também precisa estar. |
| `AUGCHATD_HOT_DIR` | não | `/var/lib/augchatd/hot` | path; criado recursive se não existir. |
| `AUGCHATD_JWT_SIGNING_KEY_CURRENT` | **sim** | — | base64; ≥ 32 bytes após decode. |
| `AUGCHATD_JWT_SIGNING_KEY_PREVIOUS` | não | — | par para rotação. |
| `AUGCHATD_JWT_TTL_SECONDS` | não | `600` | int positivo. |
| `AUGCHATD_FLUSH_IDLE_SECONDS` | não | `300` | int positivo; ociosidade por-conversa que dispara flush. |
| `AUGCHATD_TENANT_IDLE_CLOSE_SECONDS` | não | `1800` | int positivo; fecha SQLite do tenant ocioso. |
| `AUGCHATD_GC_DELAY_SECONDS` | não | `60` | int positivo; quanto após `flushed_at` o GC pode deletar a row. |
| `AUGCHATD_SHUTDOWN_DEADLINE_SECONDS` | não | `30` | int positivo; espera de streams em voo antes de força-fechar. |
| `AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS` | não | `300` | cap do backoff exponencial em flush failure. |
| `AUGCHATD_UI_DIR` | não | `${cwd}/ui/dist` (`/app/ui/dist` no container) | path; servido pela rota static. |
| `AUGCHATD_VERSION_SHA` | não | `dev` | string opaca; exposta em `GET /version`. |

Boot falha rápido com mensagem clara apontando a env var ofensora. Em `mode=prod`, ausência de qualquer das três vars mTLS obrigatórias → exit 1 com `config_invalid: <var> missing`.

#### 4.1.2 Demo-session (`DEMO_*`)

**Inalteradas vs Fatia 1.** Só lidas quando `AUGCHATD_MODE=demo`. Em `prod` são ignoradas (com log `{event:'demo_env_ignored_in_prod', var:'DEMO_*'}` se presentes).

### 4.2 Endpoints HTTP

Distribuídos entre as duas portas. Tudo erro não-401 retorna corpo `{"error": "<code>", "detail"?: ...}`. Códigos são categorizados, nunca mensagem bruta de upstream.

#### 4.2.1 Porta CONTROL (mTLS obrigatório)

| Método | Path | Request | Resposta sucesso | Erros |
|---|---|---|---|---|
| POST | `/sessions` | `SessionPayloadSchema` (JSON) | 200 `{"session_id": "<uuid>", "jwt": "<HS256>", "expires_at": <unix-seconds>}` | 400 `validation_error \| unsupported_field \| storage_unreachable \| tenant_san_ambiguous`; 503 `shutting_down` durante graceful shutdown |
| DELETE | `/sessions/{id}` | — | 204 | 404 `session_not_found` (sid não existe ou já evictado); 403 `tenant_mismatch` (sid pertence a outro tenant_id); 503 `shutting_down` |
| GET | `/health` | — | 200 `{"ok": true}` | — |
| GET | `/version` | — | 200 `{"version": "<semver>", "sha": "<sha>"}` | — |

`tenant_id` extraído do SAN URI do cert mTLS de cliente; nunca recebido no corpo. Ao mintar uma sessão, augchatd preenche `aud = tenant_id` no JWT.

`DELETE /sessions/{id}` requer `tenant_id` do cert == `tenant_id` da entrada — backend não pode deletar sessão de outro tenant mesmo com sid correto.

#### 4.2.2 Porta DATA (TLS opcional, JWT para rotas autenticadas)

| Método | Path | Auth | Notas |
|---|---|---|---|
| GET | `/health` | — | igual control |
| GET | `/version` | — | igual control |
| GET | `/demo/jwt` | — | só `mode=demo`; em `prod` retorna 404 |
| GET | `/conversations` | JWT | inalterado vs Fatia 1 |
| DELETE | `/conversations/{id}` | JWT | inalterado vs Fatia 1; agora também enfileira DELETE do prefixo S3 da conversa (eventual, não bloqueante na resposta) |
| POST | `/conversations/{id}/messages` | JWT | inalterado vs Fatia 1 + hidratação de cold se conversa não estiver hot (§5.4) |
| GET | `/*` | — | UI estática |

### 4.3 JWT e códigos 401

**Forma:** inalterada vs Fatia 1. HS256, `kid: "current" | "previous"`, claims `{iss, sub, aud, sid, iat, exp, jti}`.

**Mudança real:** `aud` agora é o tenant_id extraído do SAN URI do cert mTLS — não mais fixo `urn:augchatd-tenant:demo`.

Middleware de JWT na porta DATA, em adição às validações da Fatia 1, valida que `jwt.aud === session.tenantId` no lookup em memória; mismatch (cenário patológico: alguém forjou JWT com aud diferente, ou processo reiniciou e sid antigo virou nada) → 401 `auth_invalid`.

**Códigos 401 inalterados:** `auth_required`, `auth_invalid`, `session_not_found`, `mcp_credentials_expired`. O último permanece dead code path em Fatia 2 (sem MCP que marque `stale`); pronto para Fatia 3.

### 4.4 Códigos de erro de control plane

| Código | Quando |
|---|---|
| `validation_error` | payload viola `SessionPayloadSchema` (campo faltando, tipo errado, valor fora de range). `detail` carrega o caminho do campo. |
| `unsupported_field` | payload contém `mcp_servers`, `tools.rag` ou qualquer outro campo desconhecido. `detail.field` aponta o campo. |
| `storage_unreachable` | smoke test S3 falhou. `detail = {endpoint_host, kind}` onde `kind ∈ {timeout, auth, not_found, forbidden, server_error, unknown}`. **Nunca** a chave secreta, nunca mensagem bruta do SDK. |
| `tenant_san_ambiguous` | cert mTLS tem zero ou múltiplos SAN URIs. `detail.count` carrega o número encontrado. |
| `tls_required` | request chegou em porta CONTROL sem handshake mTLS completo. Em prática raramente atinge o handler (`rejectUnauthorized: true` corta na TLS layer); reservado para corner case. |
| `tenant_mismatch` | em `DELETE /sessions/{id}`: tenant_id do cert ≠ tenant_id armazenado para esse sid. |
| `session_not_found` | em `DELETE /sessions/{id}`: sid desconhecido ou já evictado. |
| `shutting_down` | graceful shutdown ativo; novos requests rejeitados. |

### 4.5 Protocolo `postMessage` (iframe ↔ parent)

**Inalterado vs Fatia 1.** As 5 mensagens (`augchatd:ready`, `augchatd:jwt`, `augchatd:auth-required`, `augchatd:resize`, `augchatd:fatal`) e a validação por `parent_origin` permanecem o contrato.

O caso `augchatd:fatal` continua definido mas sem gatilho real em Fatia 2.

### 4.6 mTLS — detalhes do contrato

- Server cert/key carregados de arquivo no boot. Falha de leitura/parse → exit 1 com `config_invalid: <var> unreadable_or_invalid`.
- Client CA bundle carregado de arquivo no boot. Aceita múltiplas CAs concatenadas no mesmo PEM. Falha de parse → exit 1.
- `rejectUnauthorized: true` na porta CONTROL: handshake sem client cert válido é fechado na camada TLS, sem resposta HTTP.
- SAN URI extraído na request handler via `req.socket.getPeerCertificate()` (ou equivalente do `Bun.serve`). O campo lido é `subjectAltName` filtrado por entradas URI (não DNS, não IP, não email).
- **Exatamente um** SAN URI exigido por cert. Zero ou ≥2 → 400 `tenant_san_ambiguous` antes de qualquer outro processamento (inclusive antes do schema do payload).
- Comparação tenant_id é byte-a-byte (string opaca, conforme §A.1 do arch doc).
- Sem CRL/OCSP em Fatia 2: operador roda CAs internas com revogação por rotação de bundle + restart.

---

## 5. Modelos de dados

### 5.1 SQLite por tenant

**Schema inalterado vs Fatia 1** (`schema_version='1'`). Sem migration nesta fatia. As colunas `flushed_at`, `stopped_by_shutdown`, `tool_calls` agora ganham significado real:

- `flushed_at`: setado no commit pós-PUT bem-sucedido em S3, em transação SQLite atômica cobrindo todas as rows de uma conversa.
- `stopped_by_shutdown=1`: marcado em parciais quando deadline de graceful shutdown estoura mid-stream.
- `tool_calls`: continua sempre NULL em Fatia 2 (MCP é Fatia 3).

`tenant_meta` ganha duas linhas adicionais para diagnóstico (não-públicas, não fazem parte do contrato externo):

```
('last_flush_attempt_ts', '<unix-ms da última tentativa, sucesso ou falha>')
('last_flush_error',      'ok' | '<código de erro do flush>')
```

Path em disco continua `AUGCHATD_HOT_DIR/<sha256(tenant_id)[:16]>.sqlite`. Linha `('tenant_san_uri', '<tenant_id original>')` continua sendo escrita na primeira abertura — é como recuperamos o tenant_id real após boot recovery (já que o nome do arquivo é só o hash).

### 5.2 Entrada em memória da sessão (`SessionEntry`)

```typescript
interface SessionEntry {
  tenantId: string;          // SAN URI real do cert em prod
  userId: string;
  modelProvider: 'anthropic';
  modelId: string;
  modelApiKey: string;
  systemPrompt: string;
  storage: {
    s3: {
      bucket: string;
      prefix: string;           // "" se omitido no payload (normalizado para terminar em '/' se não vazio)
      region: string;
      endpoint?: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;  // default false
    };
  };
  expiresAt: number;            // ms epoch; lazy eviction em get()
  stale: boolean;               // ainda inerte em Fatia 2 — placeholder para Fatia 3
  createdAt: number;            // ms epoch; diagnóstico em logs
  conversationsTouched: Set<string>;  // ids; usado para enfileirar flush na evicção
}
```

Store: `Map<sid, SessionEntry>` em processo. Eviction lazy em `get()` quando `expiresAt <= now()`. **Novo em Fatia 2:** evicção (lazy ou via `DELETE /sessions/{id}`) dispara enfileiramento de flush para cada conversa em `conversationsTouched`.

Em demo, `storage` é opcional e inerte (igual Fatia 1). Em prod, `storage` é obrigatório (sem fallback hot-only).

### 5.3 `SessionPayloadSchema` (Fatia 2)

Schema único, agora `.strict()` (rejeita campos desconhecidos):

```typescript
const SessionPayloadSchema = z.object({
  user_id: z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model: z.object({
    provider: z.enum(['anthropic']),
    model_id: z.string().min(1),
    api_key: z.string().min(1),
  }),
  storage: z.object({
    s3: z.object({
      bucket: z.string().min(1),
      prefix: z.string().default(''),
      region: z.string().min(1),
      endpoint: z.string().url().optional(),
      access_key_id: z.string().min(1),
      secret_access_key: z.string().min(1),
      force_path_style: z.boolean().default(false),
    }).strict(),
  }).strict(),
}).strict();
```

- Em prod (`POST /sessions`): `storage` é **obrigatório** — ausência → 400 `validation_error`.
- Em demo: o builder de payload aplica `.partial({storage: true})` (ou wrapper equivalente) antes de validar, tornando `storage` opcional. `DEMO_STORAGE_S3` (Fatia 1) é reinterpretado em Fatia 2 como JSON do objeto estruturado — operador que queria usar storage em demo passa o JSON inteiro: `DEMO_STORAGE_S3='{"bucket":"...","region":"...","access_key_id":"...","secret_access_key":"..."}'`. **Quebra cosmética da Fatia 1** (que aceitava a string `s3://...` inerte); justificada porque a forma do schema mudou e demo nunca exercitou storage de verdade.
- `.strict()` em todos os níveis garante que `mcp_servers` e `tools.rag` (que vivem no nível raiz) → 400 `unsupported_field`.

### 5.4 Layout NDJSON em S3

```
s3://<bucket>/<prefix><tenant_id>/<user_id>/<conversation_id>/
  ├── messages.ndjson
  └── meta.json
```

`prefix` é literal. Normalização: se operador passa `prefix: "augchatd/"`, ela termina em `/`; se passa `"augchatd"`, augchatd força `"augchatd/"`. Vazio é aceito (objects no root do bucket).

`tenant_id`, `user_id`, `conversation_id` são URL-path-encoded para evitar caracteres problemáticos (`/`, `..`, etc.). Em prática, com SAN URIs do tipo `urn:augchatd-tenant:<slug>`, o `:` vira `%3A`.

`messages.ndjson` — uma mensagem por linha, JSON canonical (sem newline interno, chaves ordenadas):

```jsonc
{ "id": "<uuid>", "role": "user|assistant|tool", "content": "...",
  "created_at": 1716300000000, "model_id_used": "claude-opus-4-7",
  "tool_calls": null,
  "stopped_by_user": false, "stopped_by_shutdown": false }
```

Ordem: por `created_at` ascendente, depois `id` lexicográfico como tiebreaker. PUT sempre escreve o arquivo completo (rewrite, não append) — simplifica o caminho de erro a custo de re-uploar mensagens já flushed.

`meta.json`:

```jsonc
{ "id": "<conversation_id>", "user_id": "...", "title": "<string ou null>",
  "created_at": 1716300000000, "updated_at": 1716300050000,
  "default_model": "claude-opus-4-7", "schema_version": 1 }
```

**Hidratação cold → hot:** em `POST /conversations/{id}/messages`, se a conversa não existe no SQLite hot do tenant, augchatd tenta `GET meta.json`. Se 404 → conversa nova (criação implícita Fatia 1). Se 200 → tenta `GET messages.ndjson`; 200 → parse + inserção em SQLite com `flushed_at` preenchido (já está em cold); 404 → hidrata com zero mensagens (corner case: PUT atômico interrompido entre meta e messages; flush retry vai eventualmente preencher). Falha de transporte (timeout, 5xx) em qualquer GET → 503 `storage_unreachable` para o cliente; UI tenta de novo. `meta.json` é a fonte da verdade para existência da conversa em cold.

**DELETE de conversa** = `DELETE /conversations/{id}` (porta DATA, JWT): remove rows do SQLite, depois batch DELETE do prefixo S3 `<tenant_id>/<user_id>/<conversation_id>/`. Falha de DELETE em cold é logada (`{event: 'cold_delete_failed', ...}`) mas não bloqueia o 204. Limpeza completa é eventual; operador pode rodar GC do bucket por idade se quiser.

### 5.5 Tabela em memória de tenants ativos

```typescript
interface TenantHandle {
  tenantId: string;
  dbFilePath: string;
  db: Database;                    // bun:sqlite handle
  openedAt: number;
  lastActivityAt: number;          // mexe a cada query
  pendingFlushes: Map<string, FlushState>;  // conversation_id → estado
  idleCloseTimer: Timer | null;
}

interface FlushState {
  conversationId: string;
  nextAttemptAt: number;           // ms epoch
  attemptCount: number;            // para backoff
  lastError: string | null;        // código categorizado
  inFlight: boolean;               // dedup contra trigger duplicado
}
```

Store: `Map<tenantId, TenantHandle>`. Lazy open em `getTenant(tenantId)`.

**Lifecycle:**
- Open: na primeira `POST /sessions` que precisa do tenant, OU no boot recovery scan se já existe arquivo (passa a estar "aberto mas sem sessões" — fica enquanto tem pendingFlushes; fecha em idle close timeout se zera pendências).
- Close: timer de `AUGCHATD_TENANT_IDLE_CLOSE_SECONDS` rearmado a cada `lastActivityAt` update; quando dispara, só fecha se `pendingFlushes.size === 0` E não há sessões ativas referenciando esse tenant (varre `Map<sid, SessionEntry>` por `tenantId`).
- Reopen: lazy no próximo `getTenant`.

### 5.6 Queue de flush

Singleton por processo, executando como background loop:

```typescript
interface FlushQueue {
  scheduleConversation(tenantId: string, conversationId: string, reason: 'session_eviction' | 'idle' | 'recovery'): void;
  cancelConversation(tenantId: string, conversationId: string): void;  // usado em DELETE de conversa
}
```

Internamente, loop sleep+wake. Para cada flush:
1. Lê todas as rows da conversa do SQLite hot do tenant.
2. Resolve credenciais S3: pega de qualquer `SessionEntry` viva com aquele `tenantId` e `userId` correspondente. Se nenhuma: deixa pendente; tentará de novo quando trigger dispara.
3. Constrói NDJSON + meta.json em memória.
4. **Ordem fixa:** PUT `meta.json` primeiro, depois PUT `messages.ndjson` — assim um reader que vê só meta sabe "conversa existe mas histórico está sendo escrito" (Fatia 2 não tem readers cold além do próprio augchatd; ordem é defensiva pra futuro).
5. Sucesso: `UPDATE messages SET flushed_at = ? WHERE conversation_id = ?` em transação; clear `inFlight`; remove de `pendingFlushes` se não há novas mensagens chegando.
6. Falha: `attemptCount++`, `nextAttemptAt = now + min(2^attemptCount * 1000, AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS * 1000)`, log `{event:'flush.retry', tenant_id, conversation_id, attempt, next_attempt_at, error_code}`.

Hot data **nunca** é deletado por GC enquanto `flushed_at IS NULL`. GC só toca rows já confirmadas em cold (§2 GC).

---

## 6. Mapeamento Cluster → Fatia 2

| Cluster | Entrega na Fatia 2 | Diferido a |
|---|---|---|
| **A.1** SAN URI = tenant_id | Extração via `req.socket.getPeerCertificate()`; exatamente um SAN URI exigido; string opaca | — |
| **A.2** Claims do JWT | `aud` passa a ser tenant_id real; demais claims inalterados | — |
| **A.3** Conversation lifecycle | Hidratação cold → hot adicionada; DELETE propaga para cold | — |
| **A.4** GC sessão + refresh + DELETE | `DELETE /sessions/{id}` implementado; eviction dispara flush; refresh = novo `POST /sessions` | — |
| **B** Rotação de chave JWT | Inalterado vs Fatia 1 | — |
| **C.1** NDJSON cold layout | Implementado (§5.4) | — |
| **C.2** Triggers de flush | Eviction + idle 5min | — |
| **C.3** Path em disco + recovery | Boot scan implementado; aguarda sessão para credenciais S3 | — |
| **D.1** Streaming + sanitização | Sem mudança (sem tools/RAG) | tool/RAG eventos → Fatias 3, 4 |
| **D.2** Paralelismo + limites | — | Fatia 3 |
| **D.3** Cancelamento | Inalterado vs Fatia 1 + `stopped_by_shutdown=1` marcado em graceful shutdown deadline | — |
| **D.4** Categorias de erro | `shutting_down` adicionado; `mcp_*` continuam reservados | Fatia 3 |
| **E** RAG | — | Fatia 4 |
| **F.1** postMessage 5 mensagens | Inalterado | — |
| **F.2** `parent_origin` validation | Inalterado | — |
| **F.3** CSP `frame-ancestors` | Permissivo (igual Fatia 1) | per-tenant → futuro |
| **G** Processo + deploy | Graceful shutdown completo com flush sincrônico; lazy open/close per-tenant | — |
| **G** `DELETE /tenants/{id}` | — | manual; vira endpoint quando virar dor |
| **H** Config | Env vars only; renames documentados (§4.1) | — |
| **I** Observabilidade | Eventos novos de flush/tenant/recovery; `/health` e `/version` em ambas as portas | `/metrics` → futuro |

---

## 7. Critérios de aceite

A Fatia 2 está "pronta" quando **todos** os itens abaixo são verificáveis:

- [ ] `bun test` passa (unit + e2e in-process; e2e cobre `POST /sessions` com mTLS de teste auto-gerado).
- [ ] `bun run build` (backend + UI) completa sem warnings de tipo.
- [ ] `docker build -t augchatd:dev .` completa.
- [ ] Smoke prod (script em `scripts/smoke-prod.sh`): boota container com cert/key/CA de teste e MinIO local; `curl --cert client.pem --key client.key https://localhost:8443/sessions -d '<payload>'` retorna 200 com `{session_id, jwt, expires_at}`.
- [ ] Mesma chave Anthropic real consumida via mTLS prod: mensagem é mintada, UI conecta, response streamada.
- [ ] **Durabilidade:** após uma conversa em prod, esperar `AUGCHATD_FLUSH_IDLE_SECONDS` (ou disparar `DELETE /sessions/{id}`); verificar que `messages.ndjson` aparece em MinIO. Kill `-9` no daemon; restart; mandar mensagem nova na mesma conversa (precisa novo JWT via `POST /sessions`) — histórico anterior aparece (hidratado de cold).
- [ ] **Multi-tenant:** dois certs diferentes (SAN URI distintos) provisionam sessões; cada um cria SQLite separado em `AUGCHATD_HOT_DIR`; tentativa de tenant A acessar conversa de tenant B (mesmo com `conversation_id` correto) retorna 403 (já era Fatia 1, agora valida com tenants reais).
- [ ] **Graceful shutdown:** SIGTERM no meio de um stream → resposta termina dentro do deadline; mensagem parcial persiste com `stopped_by_shutdown=1`; flush sincrônico escreve em cold antes do exit; restart hidrata limpo.
- [ ] **Boot recovery:** kill `-9` durante mensagem em voo → restart → boot scan loga `recovery.pending_found`; nova `POST /sessions` para o tenant dispara flush das pendências.
- [ ] **Smoke test S3 real:** `POST /sessions` com `access_key_id` errado retorna 400 `storage_unreachable` em < 5s; logs não vazam o secret.
- [ ] Demo mode (Fatia 1) continua funcionando: `docker run -e AUGCHATD_MODE=demo ...` ainda boota com data plane só, sem porta CONTROL.

Não-critérios (não bloqueiam):
- Publicação de imagem em registry.
- README atualizado para refletir formato estruturado de `storage.s3` (tracking: issue separada; a spec é fonte da verdade entre os dois).
- Cobertura de testes acima de algum threshold.

---

## 8. Decisões deferidas explicitamente

| Item | Por que fora da Fatia 2 |
|---|---|
| MCP client | Fatia 3. Schema continua rejeitando `mcp_servers` com 400 `unsupported_field`. |
| RAG | Fatia 4. Schema continua rejeitando `tools.rag`. |
| `DELETE /tenants/{id}` | Sem dor operacional ainda; decomissionamento manual é aceitável. Vira endpoint quando virar fricção. |
| `/metrics` | Operador pluga sidecar OTel. Sem ROI claro pra augchatd ter opinião sobre formato. |
| Hot reload de TLS/JWT material | Restart-only; alinhado com cert-manager moderno. |
| CSP `frame-ancestors` per-tenant | Sem mecanismo de config-per-tenant fora do payload de sessão. Permissivo + JWT é defesa real. |
| `POST /sessions/{id}/jwt` ("renew only") | Não existe; alinhado com "augchatd holds no refresh logic" do README. |
| Cache de smoke test S3 | ~100ms por `POST /sessions` é aceitável; cache adiciona complexidade de invalidação. |
| Per-tenant rate limiting | README declara fora do produto. |
| Cap explícito de sessões por usuário | Soft cap via memória; sem hard limit em Fatia 2. |
| Encryption client-side antes de PUT S3 | Operador configura SSE-S3/SSE-KMS no bucket. |
| Detecção de conflito quando S3 config do tenant muda entre boots | Operador é responsável; novo destino é fonte da verdade. |
| `/ready` separado de `/health` | Boot recovery é async; não bloqueia tráfego. |
| Single-binary `bun build --compile` | Não bloqueia o demo; Docker é suficiente. |
| `mcp_credentials_expired` marcação real | Continua dead code path em Fatia 2; ativa na Fatia 3. |

---

## 9. Próximos passos

1. Esta spec é commitada.
2. Plano de implementação é gerado em `docs/superpowers/plans/2026-05-22-augchatd-fatia-2-producao.md` via skill `writing-plans`, consumindo esta spec + o arch doc como entrada.
3. Execução do plano segue via `subagent-driven-development` ou `executing-plans`. **Pré-requisito:** Fatia 1 implementada e mergeada (esta fatia herda a base de código da Fatia 1; sem ela não há de onde estender).
4. Específicos a corrigir no README após Fatia 2 mergeada (não bloqueante da spec): formato `storage.s3` (string → objeto), nota sobre `AUGCHATD_LISTEN_DATA` / `AUGCHATD_LISTEN_CONTROL`, nota sobre `mcp_servers`/`tools.rag` ainda não implementados.
