# augchatd — Spec da Fatia 1 (MVP demo end-to-end)

**Data:** 2026-05-21
**Status:** Aprovado (brainstorming concluído)
**Documento pai:** `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md` (decisões transversais).
**Plano de implementação:** `docs/superpowers/plans/2026-05-21-augchatd-fatia-1-mvp-demo.md` (TDD task-by-task).
**Escopo deste documento:** congelar **o que** entrega a Fatia 1 — escopo, contratos externos, modelos de dados, critérios de aceite. **Não escopo:** ordem de implementação, código de exemplo, comandos shell (isso fica no plano).

---

## 1. Objetivo

Provar a forma end-to-end de augchatd em sua configuração mais simples possível: um único binário/imagem que, dado apenas uma chave de LLM e uma chave de assinatura de JWT, serve uma UI de chat funcional, persiste histórico em SQLite local e faz streaming de respostas via Vercel AI SDK. Tudo isso sem mTLS, sem MCP, sem RAG, sem S3 obrigatório, sem múltiplos tenants em prática.

O que a Fatia 1 desbloqueia:
- A promessa de "Quick Start (demo mode)" do `README.md` passa a funcionar literalmente.
- Esqueleto de auth (JWT HS256 com rotação `kid`), storage (SQLite por tenant, schema final) e UI (assistant-ui bundled + protocolo `postMessage`) fica de pé para as fatias seguintes herdarem sem retrabalho.
- Loop de feedback de desenvolvimento curto: qualquer mudança no daemon roda contra um cenário real sem precisar de infra externa.

O que a Fatia 1 **não** quer provar: produção, multi-tenant operacional, tools, retrieval, durabilidade S3. Cada um disso tem fatia própria.

---

## 2. Escopo: o que entra

| Área | Decisão |
|---|---|
| Modo | `AUGCHATD_MODE=demo` apenas. Uma sessão fixa carregada do environment no boot. |
| Identidade | Tenant fixo `urn:augchatd-tenant:demo`. User fixo `demo-user`. Session id fixo `demo`. |
| Auth | JWT HS256, header `kid: "current" \| "previous"`, claims `{iss, sub, aud, sid, iat, exp, jti}`. Rotação de chave suportada (current assina, ambas verificam). |
| Sessão | Entrada em memória com TTL longo (~365d em demo) e flag `stale` (dead code path em Fatia 1: ninguém marca, pois não há MCP). |
| Storage | SQLite por tenant em `AUGCHATD_HOT_DIR`. Schema final (conversations, messages, tenant_meta). WAL ligado. Coluna `flushed_at` existe mas permanece NULL (sem flush em Fatia 1). |
| LLM | Vercel AI SDK + `@ai-sdk/anthropic`. Streaming via `result.toDataStreamResponse()`. Anthropic é o único provider em Fatia 1. |
| Conversa | Criação implícita na primeira mensagem (UI gera o `conversation_id`). Escopo `(tenant_id, user_id)` estrito. Listagem e delete. |
| UI | React + Vite + `@assistant-ui/react` + `@assistant-ui/react-ai-sdk`, buildada para `ui/dist/`, servida pelo backend na mesma origem. |
| Embed | Protocolo `postMessage` completo (5 mensagens, ver §4.4). `parent_origin` lido da query string para validação. |
| UI standalone | Quando carregada sem `parent_origin` na query, a UI faz `GET /demo/jwt` direto. **Atalho específico do `AUGCHATD_MODE=demo`**, não contrato público — não funciona em prod. |
| Streaming protocol | Vercel AI SDK data stream nativo (assistant-ui consome direto). Cancelamento via `AbortSignal` do request HTTP propagado para `streamText`. |
| Observabilidade | Logger JSON estruturado em stderr (campos `level`, `ts`, `event`, `msg` + contextuais). `GET /health` e `GET /version` sem auth. |
| Deploy | Dockerfile multi-stage (build UI, runtime backend). Imagem buildável; publicação no registry não é critério de aceite. |
| Shutdown | SIGINT/SIGTERM param o servidor (`server.stop(false)`) e fazem `process.exit(0)`. Sem flush ordenado (não há cold em Fatia 1). |

---

## 3. Escopo: o que NÃO entra

Tudo abaixo é conscientemente fora — pertence a fatias subsequentes (§2 do arch doc) ou está deferido transversalmente (§13 do arch doc):

**Fatia 2 (produção):**
- mTLS (server cert/key, client CA bundle).
- `POST /sessions` (control plane).
- `DELETE /sessions/{id}` (encerramento out-of-band).
- S3 cold storage, flush por-conversa, NDJSON layout, GC após flush.
- Multi-tenant operando de verdade (Fatia 1 abre estrutura mas só roda com um tenant).
- Boot recovery scan de SQLite hot com flush pendente.
- Graceful shutdown com flush sincrônico.

**Fatia 3 (MCP):**
- Cliente MCP HTTP/SSE, pool de conexões.
- Execução paralela de tool calls (`Promise.all`, cap 8).
- Loop limits, total timeout, per-tool timeout.
- MCP 401 → marcação de `stale` na sessão.
- Evento `3: error { code: "mcp_credentials_expired", session_action: "refresh" }` no data stream — o **código** já existe como resposta 401 do JWT middleware, mas a marcação `stale` mid-stream não tem origem real ainda.

**Fatia 4 (RAG):**
- Backends OpenSearch e pgvector, embedding local opcional, multi-index com interseção de escopo.

**Cross-cutting deferido:**
- CSP `frame-ancestors` por tenant (Fatia 1 fica permissivo).
- Endpoint `/metrics` (operador pluga sidecar OTel se quiser).
- Hot reload de chaves JWT ou TLS material (restart-only).
- Per-tenant rate limiting.
- CLI subcommands, single-binary `bun build --compile`, publicação Docker.

---

## 4. Contratos externos

Tudo nesta seção é **público e congelado** ao fim da Fatia 1: mudanças quebram clientes (UI bundled ou parent embedder). Trocas de forma exigem revisão explícita.

### 4.1 Variáveis de ambiente

#### 4.1.1 Process-level (`AUGCHATD_*`)

| Variável | Obrigatória | Default | Validação |
|---|---|---|---|
| `AUGCHATD_MODE` | não | `demo` | `demo` ou `prod` (Fatia 1 só implementa `demo`; `prod` boota mas não tem rotas pra mintar sessão) |
| `AUGCHATD_LISTEN` | não | `0.0.0.0:8080` | formato `host:port` |
| `AUGCHATD_HOT_DIR` | não | `/var/lib/augchatd/hot` | path; criado `recursive` se não existir |
| `AUGCHATD_JWT_SIGNING_KEY_CURRENT` | **sim** | — | base64 decodificável; ≥ 32 bytes após decode |
| `AUGCHATD_JWT_SIGNING_KEY_PREVIOUS` | não | — | mesma validação; opcional para rotação |
| `AUGCHATD_JWT_TTL_SECONDS` | não | `600` | inteiro positivo |
| `AUGCHATD_UI_DIR` | não | `${cwd}/ui/dist` (ou `/app/ui/dist` no container) | path; servido pela rota static |
| `AUGCHATD_VERSION_SHA` | não | `dev` | string opaca; exposta em `GET /version` |

Boot falha rápido com mensagem clara apontando a env var ofensora.

#### 4.1.2 Demo-session (`DEMO_*`), só lidos quando `AUGCHATD_MODE=demo`

| Variável | Obrigatória | Default | Validação |
|---|---|---|---|
| `DEMO_MODEL_PROVIDER` | sim | — | apenas `anthropic` em Fatia 1 |
| `DEMO_MODEL_ID` | sim | — | string não vazia |
| `DEMO_MODEL_API_KEY` | sim | — | string não vazia |
| `DEMO_SYSTEM_PROMPT` | não | `"You are a helpful assistant."` | string |
| `DEMO_STORAGE_S3` | não | — | string; **aceita e validada pelo schema, mas sem efeito em Fatia 1**. Mantida para preservar a invariante "demo usa o mesmo `SessionPayloadSchema` que prod" (§H.3 do arch doc). Toma efeito na Fatia 2. |

Demo constrói um `SessionPayload` "como se" tivesse vindo de `POST /sessions`, valida pelo `SessionPayloadSchema` único, e carrega a sessão na memória com `sid="demo"`, `expiresAt = now + 365d`, `stale = false`.

### 4.2 Endpoints HTTP

Servidor único na porta `AUGCHATD_LISTEN`. Sem mTLS na Fatia 1 — JWT é toda a autenticação.

| Método | Path | Auth | Request | Resposta | Notas |
|---|---|---|---|---|---|
| GET | `/health` | nenhuma | — | 200 `{"ok": true}` | liveness probe |
| GET | `/version` | nenhuma | — | 200 `{"version": "<semver>", "sha": "<sha>"}` | exposição operacional |
| GET | `/demo/jwt` | nenhuma | — | 200 `{"jwt": "<HS256 jwt>", "expires_at": <unix-seconds>}` ou 404 se `mode != demo` | **só demo**; minta JWT fresco para a sessão `demo` |
| GET | `/conversations` | JWT | — | 200 `{"conversations": [{"id", "userId", "title", "createdAt", "updatedAt"}, ...]}` | escopo `(tenant_id, user_id)` do JWT |
| DELETE | `/conversations/{id}` | JWT | — | 204; 403 `{"error":"forbidden"}` se a conversa pertence a outro user | idempotente em ausência |
| POST | `/conversations/{id}/messages` | JWT | `{"message": "<string não vazia>"}` | 200 stream Vercel AI SDK data stream protocol (Content-Type `text/plain; charset=utf-8`); 400 se body inválido; 403 se a conversa pertence a outro user | cria conversa implicitamente; cancelamento via fechamento do stream propagado para `streamText` |
| GET | `/*` | nenhuma | — | UI estática de `AUGCHATD_UI_DIR`. Path existente serve o arquivo; path inexistente cai em `index.html` (SPA fallback). | API routes precedem o catch-all |

Erros não-401: corpo `{"error": "<code>", "detail"?: ...}`. Códigos categorizados, nunca mensagem bruta de upstream (princípio §I do arch doc).

### 4.3 JWT e códigos de erro 401

**Forma:**
- `alg: "HS256"`, `kid: "current" | "previous"`.
- Claims: `{iss: "augchatd", sub: <user_id>, aud: <tenant_id>, sid: <session_id>, iat, exp, jti: <uuid>}`.
- TTL = `AUGCHATD_JWT_TTL_SECONDS` (default 600).

**Códigos 401 retornados pelo middleware de JWT — parte do contrato público.** A UI bundled mapeia cada código para um `reason` no `augchatd:auth-required` (§4.4). Mudar esses códigos exige bump no contrato browser API.

| Código (body `error`) | Quando |
|---|---|
| `auth_required` | header `Authorization` ausente ou não é `Bearer …` |
| `auth_invalid` | JWT mal-formado, assinatura ruim, `kid` desconhecido, claims faltando |
| `session_not_found` | `sid` válido criptograficamente mas a entrada em memória não existe (TTL natural expirou, processo reiniciou, etc.) |
| `mcp_credentials_expired` | sessão em memória existe mas está marcada `stale`. **Dead code path em Fatia 1** (sem MCP para marcar), mas o código e o handling existem para a UI já consumir corretamente. |

### 4.4 Protocolo `postMessage` (iframe ↔ parent)

Conjunto fechado de 5 mensagens (§F.1 do arch doc). Sem mensagens granulares por turno; conteúdo de conversa nunca cruza para o parent.

| Mensagem | Direção | Payload | Quando |
|---|---|---|---|
| `augchatd:ready` | iframe → parent | `{}` | UI montou |
| `augchatd:jwt` | parent → iframe | `{ jwt: string }` | Resposta à `ready` ou após `auth-required` |
| `augchatd:auth-required` | iframe → parent | `{ reason: "jwt_expired" \| "jwt_invalid" \| "mcp_credentials_expired" \| "session_revoked" }` | Mapeado a partir do código 401 (§4.3) |
| `augchatd:resize` | iframe → parent | `{ height: number }` | `ResizeObserver` no `documentElement` |
| `augchatd:fatal` | iframe → parent | `{ code: string, message: string }` | erro irrecuperável de boot. **Definida no protocolo mas sem gatilho real em Fatia 1** — reservada para erros futuros (ex.: incompatibilidade de versão UI/backend). O único caso fatal em Fatia 1 (standalone sem `/demo/jwt` disponível) ocorre quando não há parent para notificar; é renderizado inline. |

**Validação de origem:**
- Parent declara sua própria origin via query string ao carregar o iframe: `<iframe src="https://augchatd/?parent_origin=https%3A%2F%2Fapp.example.com">`.
- UI lê `parent_origin` e só aceita `MessageEvent` com `e.origin === parent_origin` exatamente. Emissão (`window.parent.postMessage`) usa o mesmo valor como `targetOrigin`.

**Modo standalone (demo):** se `parent_origin` está ausente, a UI **não** instala o bridge — em vez disso, faz `fetch('/demo/jwt')` e usa o JWT recebido. É atalho do demo, não promessa do contrato.

**Mapeamento código 401 → `auth-required.reason`:**
- `mcp_credentials_expired` → `mcp_credentials_expired`
- `session_not_found` → `session_revoked`
- `auth_invalid` → `jwt_invalid`
- `auth_required` ou qualquer outro 401 → `jwt_expired` (default)

---

## 5. Modelos de dados

### 5.1 SQLite por tenant (schema normativo da Fatia 1)

Um arquivo por tenant em `AUGCHATD_HOT_DIR/<sha256(tenant_id)[:16]>.sqlite`. Em Fatia 1, sempre `urn:augchatd-tenant:demo` → um único arquivo.

Aberto com:
- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`

```sql
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  default_model TEXT
);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,              -- 'user' | 'assistant' | 'tool'
  content             TEXT NOT NULL,
  tool_calls          TEXT,                       -- JSON, NULL em Fatia 1
  model_id_used       TEXT,
  created_at          INTEGER NOT NULL,
  flushed_at          INTEGER,                    -- existe, sempre NULL em Fatia 1
  stopped_by_user     INTEGER NOT NULL DEFAULT 0,
  stopped_by_shutdown INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_flush ON messages(flushed_at);
CREATE INDEX idx_conv_user ON conversations(user_id, updated_at);

CREATE TABLE tenant_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- linhas garantidas na abertura:
--   ('tenant_san_uri', '<tenant_id original>')
--   ('schema_version', '1')
```

`tool_calls` e os campos `stopped_by_*` existem porque ficam aparecendo nas fatias seguintes (Fatia 3 escreve `tool_calls`; Fatia 2 marca `stopped_by_shutdown` no graceful shutdown). Mantê-los desde Fatia 1 evita migração em cada fatia.

### 5.2 Entrada em memória da sessão (`SessionEntry`)

```typescript
interface SessionEntry {
  tenantId: string;          // 'urn:augchatd-tenant:demo' em Fatia 1
  userId: string;            // 'demo-user' em Fatia 1
  modelProvider: 'anthropic';
  modelId: string;
  modelApiKey: string;
  systemPrompt: string;
  storage?: { s3: string };  // aceito mas inerte em Fatia 1
  expiresAt: number;         // ms epoch; lazy eviction no get()
  stale: boolean;            // sempre false em Fatia 1
}
```

Store: `Map<sid, SessionEntry>` em processo. Eviction lazy em `get()` quando `expiresAt <= now()`. `markStale(sid)` flipa a flag (chamado por nada em Fatia 1; existe para o middleware ter o caminho pronto).

### 5.3 `SessionPayloadSchema` (subset da Fatia 1)

Schema único usado pelo demo builder (e que será reusado por `POST /sessions` na Fatia 2). Fatia 1 implementa apenas o subset abaixo; campos adicionais (`mcp_servers`, `tools.rag`) ficam para fatias futuras.

```typescript
const SessionPayloadSchema = z.object({
  user_id: z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model: z.object({
    provider: z.enum(['anthropic']),       // ampliar em fatias futuras
    model_id: z.string().min(1),
    api_key: z.string().min(1),
  }),
  storage: z.object({ s3: z.string().min(1) }).optional(),
});
```

---

## 6. Mapeamento Cluster → Fatia 1

Para cada cluster do arch doc, o que a Fatia 1 entrega vs. defere. Toda linha "deferred" é compatível com o respectivo cluster — só não é implementada.

| Cluster | Entrega na Fatia 1 | Diferido a |
|---|---|---|
| **A.1** SAN URI = tenant_id | Tenant fixo `urn:augchatd-tenant:demo` (sem mTLS para extrair SAN) | Fatia 2 |
| **A.2** Claims do JWT | Completo: `iss/sub/aud/sid/iat/exp/jti`, HS256, `kid` | — |
| **A.3** Conversation lifecycle | Criação implícita, escopo `(tenant, user)`, list, delete | — |
| **A.4** GC sessão + refresh + DELETE | TTL via eviction lazy; `markStale` existe; refresh demo = re-fetch `/demo/jwt` | `DELETE /sessions/{id}` → Fatia 2 |
| **B** Rotação de chave JWT | `current` + `previous` opcional, header `kid` | — |
| **C.1** NDJSON cold layout | — | Fatia 2 |
| **C.2** Triggers de flush | — | Fatia 2 |
| **C.3** Path em disco + recovery | Path configurável, hash do tenant, schema final, WAL. **Sem** boot recovery scan (nada para hidratar). | recovery → Fatia 2 |
| **D.1** Streaming + sanitização | Stream `text-delta` via Vercel AI SDK data stream. Sem `9/a/2/3` events (não há tools/RAG). | tool/RAG eventos → Fatias 3, 4 |
| **D.2** Paralelismo + limites | — (sem tools) | Fatia 3 |
| **D.3** Cancelamento | `AbortSignal` do request HTTP propagado para `streamText` | persistência parcial com `stopped_by_user=true` em corner case → Fatia 3 |
| **D.4** Categorias de erro | Códigos 401 do middleware (§4.3); demais códigos (`loop_limit_exceeded`, `total_timeout`, `mcp_unreachable`) só aparecem com tools | Fatia 3 |
| **E** RAG | — | Fatia 4 |
| **F.1** postMessage 5 mensagens | Completo | — |
| **F.2** `parent_origin` validation | Completo | — |
| **F.3** CSP `frame-ancestors` | Permissivo (default do Hono) | per-tenant → futuro |
| **G** Processo + deploy | Bun.serve, SIGINT/SIGTERM stop, sem flush sincrônico (não tem cold) | graceful flush → Fatia 2 |
| **H** Config | Env vars apenas (§4.1). Mesmo `SessionPayloadSchema` em demo e prod (subset). | — |
| **I** Observabilidade | Logger JSON; `/health`, `/version`; nada sensível em log | `/metrics` → futuro |

---

## 7. Critérios de aceite

A Fatia 1 está "pronta" quando **todos** os itens abaixo são verificáveis:

- [ ] `bun test` passa (todos os unit + e2e in-process).
- [ ] `bun run build` (backend + UI Vite) completa sem warnings de tipo.
- [ ] `docker build -t augchatd:dev .` completa.
- [ ] Smoke test do container: `curl /health` → `{"ok":true}` e `curl /demo/jwt` → `{"jwt": "...", "expires_at": ...}`.
- [ ] Quickstart do `README.md` reproduz: `docker run` com `DEMO_MODEL_API_KEY` real (Anthropic), abrir `http://localhost:8080`, mandar mensagem, receber resposta streamada do LLM real.
- [ ] Recarregar a página após uma conversa: a conversa anterior aparece em `GET /conversations` e pode ser continuada (estado preservado em SQLite hot).
- [ ] Deletar uma conversa via UI/API remove ela do listing.

Não-critérios (não bloqueiam):
- Publicação da imagem Docker em registry.
- Documentação além do `README.md` existente.
- Cobertura de testes acima de algum threshold (não há meta numérica — TDD garante por construção).

---

## 8. Decisões deferidas explicitamente

São coisas que poderiam estar na Fatia 1 mas não estão, com a razão:

| Item | Por que fora da Fatia 1 |
|---|---|
| `POST /sessions` / mTLS / control plane | Pertence à Fatia 2 (modo prod). Demo cobre toda a superfície necessária para validar a forma. |
| `DELETE /sessions/{id}` | Só faz sentido pareado com `POST /sessions`. Sem origem real para sessões em Fatia 1. |
| S3 cold storage + flush + GC | Fatia 2. Hot-only é aceitável em demo (perde dados se apagar o volume; documentado). |
| Boot recovery scan | Sem cold storage, não há nada para recuperar. |
| Graceful shutdown com flush sincrônico | Sem cold para flush; `server.stop(false)` é suficiente em Fatia 1. |
| MCP client | Fatia 3. Toda a estrutura de erro (`mcp_credentials_expired`, marcação `stale`) já existe mas é dead code path em Fatia 1. |
| RAG | Fatia 4. |
| `/metrics` | Operador pluga sidecar OTel — sem ROI para Fatia 1. |
| CSP `frame-ancestors` per-tenant | Sem mecanismo de config-per-tenant em Fatia 1 (só uma sessão). Permissivo é seguro porque JWT é a defesa real. |
| Hot reload de JWT/TLS material | Restart-only, alinhado com §H do arch doc. |
| Per-tenant rate limiting | README já declara fora de escopo do produto. |
| Embedded single-binary (`bun build --compile`) | Não bloqueia o demo; Docker é suficiente. |
| Publicação `augchatd/augchatd` no Docker Hub | Critério de release, não de implementação da fatia. |

---

## 9. Próximos passos

1. Esta spec é commitada.
2. Plano de implementação **já existe** em `docs/superpowers/plans/2026-05-21-augchatd-fatia-1-mvp-demo.md` (24 tasks TDD). Foi escrito direto do arch doc; agora esta spec o cobre formalmente. Qualquer divergência futura entre plano e spec deve ser resolvida a favor da spec (e atualizada).
3. Execução do plano segue via `subagent-driven-development` (recomendado pelo próprio plano) ou `executing-plans`.
4. Specs subsequentes (Fatias 2-4) reusam o arch doc como cabeçalho arquitetural e seguem o mesmo formato desta spec.
