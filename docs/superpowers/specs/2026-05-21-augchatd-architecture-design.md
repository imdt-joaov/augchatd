# augchatd — Design arquitetural de alto nível

**Data:** 2026-05-21
**Status:** Aprovado (brainstorming arquitetural concluído)
**Escopo deste documento:** decisões de forma — interfaces, contratos, modelos de dados, lifecycle. **Não escopo:** schemas SQL exatos, paths HTTP completos, código de exemplo, plano de implementação. Esses ficam nas specs por fatia (ver §11).

---

## 1. Objetivo

Consolidar as decisões arquiteturais que fecham gaps deixados em aberto pelo `README.md`, de modo que as specs de cada fatia vertical possam ser escritas sem precisar resolver questões transversais de novo.

O `README.md` permanece a fonte da verdade para **o que** augchatd faz e quais promessas externas oferece. Este documento decide **como** essas promessas se manifestam estruturalmente.

---

## 2. Decomposição em fatias verticais

augchatd inteiro é grande demais para uma única implementação. As decisões deste documento se aplicam a todas as fatias, mas a entrega segue:

- **Fatia 1 — MVP demo end-to-end**: `AUGCHATD_MODE=demo` + LLM (Vercel AI SDK) + SQLite hot + JWT + UI assistant-ui empacotada + iframe via `postMessage`. Sem MCP, sem RAG, sem S3 obrigatório, sem mTLS.
- **Fatia 2 — Modo produção**: mTLS + `POST /sessions` + multi-tenant (um SQLite por tenant) + S3 cold storage + flush/hidratação + `DELETE /sessions/{id}`.
- **Fatia 3 — Cliente MCP**: HTTP/SSE, multi-servidor, com credenciais por sessão + propagação de 401 para refresh.
- **Fatia 4 — RAG**: um backend primeiro (a definir entre OpenSearch e pgvector na spec da fatia), depois o outro.

Cada fatia tem sua própria spec, plano e implementação. Nenhuma decisão posterior pode contradizer este documento sem revisão explícita.

---

## 3. Cluster A — Modelo de identidade

### A.1 — `tenant_id` = SAN URI do cert mTLS

O daemon extrai o `tenant_id` de um SAN URI presente no certificado mTLS do cliente. Formato recomendado para novos tenants: `urn:augchatd-tenant:<slug>`. O daemon trata como **string opaca**: qualquer SAN URI funciona; comparação é byte-a-byte.

**Por quê SAN URI e não CN ou SPKI hash:** sobrevive a rotação de cert (reemissão preserva o SAN), é explícito (versus implícito do CN), e é trivial de validar.

### A.2 — Claims do JWT

```jsonc
{
  "iss": "augchatd",
  "sub": "<user_id>",            // identifica usuário dentro do tenant
  "aud": "<tenant_id>",          // SAN URI; defesa em profundidade
  "sid": "<session_id>",         // chave para lookup em memória das credenciais
  "iat": 1716300000,
  "exp": 1716300600,             // ~10 min (configurável)
  "jti": "<uuid>"                // suporta revogação eventual
}
```

**Sem `scope` no JWT.** Quais MCP servers / índices RAG / model este usuário pode usar vive apenas na entrada em memória keyed por `sid`. Razão: rotação de escopo no backend (revogar acesso a um índice) toma efeito na próxima sessão, sem ficar preso em JWT antigo.

**"No DB lookup per message"** (do README) significa nenhuma roundtrip a disco/SQLite/S3 — lookup em hashmap em memória pelo `sid` para recuperar credenciais é parte normal do processamento da request, não viola a promessa.

### A.3 — Escopo e lifecycle de `conversation_id`

`session_id` e `conversation_id` são **separados em escopo e tempo de vida**:

| | `session_id` | `conversation_id` |
|---|---|---|
| Escopo | `(tenant_id, user_id)` + credenciais daquele momento | `(tenant_id, user_id)` |
| Tempo de vida | Minutos a horas (atrelado ao JWT) | Indefinido (controlado pelo usuário) |
| Persistência | Só em memória | SQLite (hot) → S3 (cold) |

Decisões:
- **ACL: `(tenant_id, user_id)` estrito.** Só o mesmo user do mesmo tenant lê/escreve a conversa. Sem compartilhamento entre membros do tenant na v1.
- **Criação implícita:** a primeira mensagem cria a conversa. UI gera o `conversation_id` no cliente (UUID) e faz `POST /conversations/{id}/messages` direto.
- **Continuidade entre sessões:** uma conversa pode ser continuada por uma sessão diferente (com possivelmente outro `model_id`). Cada mensagem registra qual modelo a gerou.
- **`POST /sessions` não recebe `conversation_id`.** Conversas são listadas com `GET /conversations` filtrado pelos claims do JWT.

### A.4 — Lifecycle da entrada em memória e refresh do JWT

- **Toda renovação de JWT é um novo `POST /sessions`.** Não existe endpoint de "renew JWT" — alinhado com *"augchatd holds no refresh logic"*. Custo trivial (poucos KB de JSON sobre mTLS, a cada ~10 min).
- **GC da entrada em memória:** TTL = `JWT.exp + 60s` de graça. Sem refcount; entradas evictadas mesmo com requests em voo (a request em voo já tem referência via closure, completa sem problema).
- **Lookup de credenciais é feito uma única vez por request, na abertura.** O handler captura referências a credenciais/escopo via closure e usa essas referências durante toda a request, inclusive em streams longos. Evicção da entrada em memória **durante** a request não afeta a request em curso.
- **Streams em voo durante expiração:** JWT e credenciais são validados/capturados **só na abertura** do request. Stream em curso completa normalmente. **Próximo** turno é que recebe 401 e dispara refresh.
- **Encerramento out-of-band:** `DELETE /sessions/{id}` (mTLS) remove a entrada imediatamente. Próximas requests com aquele `sid` retornam 401; requests em voo no momento do delete completam.

---

## 4. Cluster B — Estratégia de chave do JWT

- **Algoritmo: HS256** (HMAC-SHA256). Daemon é signer e verifier; criptografia assimétrica é overhead sem benefício.
- **Escopo: uma chave global por processo.** Tenants mutuamente hostis devem rodar em processos separados (já recomendado pelo README).
- **Rotação suportada:** duas chaves ativas simultaneamente (`current` assina, ambas verificam). JWT carrega header `kid: "current" | "previous"`.
- **Fonte: variáveis de ambiente.** `AUGCHATD_JWT_SIGNING_KEY_CURRENT=<base64>`, `AUGCHATD_JWT_SIGNING_KEY_PREVIOUS=<base64>` (opcional). Rotação sem downtime: deploy com (`new`, `old`), aguardar `max_jwt_ttl`, deploy com (`new`, `null`).

---

## 5. Cluster C — Storage hot/cold

### C.1 — Cold storage: per-conversation NDJSON em S3

Layout:
```
s3://<bucket>/<prefix>/<tenant_id>/<user_id>/<conversation_id>/
  ├── messages.ndjson   # uma mensagem por linha
  └── meta.json         # título, timestamps, modelo padrão
```

Cada linha de `messages.ndjson` contém: `role`, `content`, `tool_calls?`, `metadata?`, `created_at`, `model_id_used?`.

**Por quê NDJSON e não SQLite dump nem per-message objects:** hidratação parcial é trivial, append-friendly se evoluirmos, inspeção humana fácil, `DELETE` de conversa = `DELETE` de prefixo, migração entre buckets sem ferramenta especial.

### C.2 — Triggers de flush

Flush é **por-conversa**, disparado por **qualquer** uma das condições:

- **Evicção da sessão** que tocou aquela conversa (TTL natural ou `DELETE /sessions/{id}`).
- **5 min sem nova mensagem** naquela conversa específica (não global por tenant).

### C.3 — Path em disco e recovery após restart

- **Path configurável**, default `/var/lib/augchatd/hot/`. Um arquivo por tenant: `<sha256(tenant_id)[:16]>.sqlite`. Mapeamento hash → SAN URI original em tabela interna `tenant_meta`.
- **Marcação de flush:** cada linha de mensagem tem `flushed_at` (nullable timestamp). Flush bem-sucedido seta `flushed_at` e escreve NDJSON completo. **Delete só acontece num passe de GC ≥ 60s depois** de `flushed_at`, evitando race com escritas em voo.
- **Boot recovery:** daemon varre o diretório hot, abre cada SQLite, identifica conversas com `max(message.created_at) > max(flushed_at)`, enfileira retry de flush — independente de sessões ativas.
- **Falha permanente:** backoff exponencial (cap em 5 min entre tentativas), log estruturado, métrica eventualmente. **Nunca corrompe nem dropa dados hot.**

---

## 6. Cluster D — Loop tool-use

### D.1 — Protocolo de streaming e sanitização

Canal: Vercel AI SDK data stream protocol (assistant-ui native). O que vai em cada evento:

| Evento | Inclui | NÃO inclui |
|---|---|---|
| `9: tool-call` | `tool_name`, `tool_call_id`, `args` | URL/headers/transporte do MCP server |
| `a: tool-result` | `tool_call_id`, resultado do MCP ou erro estruturado | Headers de resposta, traços de transporte |
| `2: data` | `doc_id` lógico + snippet (RAG) | Cluster, host, índice subjacente |
| `3: error` | Código categorizado (`mcp_credentials_expired`, `mcp_unreachable`, `llm_rate_limited`, `loop_limit_exceeded`, `total_timeout`) | Mensagem bruta de upstream, stack trace |

Princípio: **info do nível do usuário vai; identidade da topologia da infra do operador, não vai.**

### D.2 — Paralelismo e limites

- Tool calls que o LLM emite em paralelo executam em paralelo (`Promise.all`), com **cap de concorrência = 8** (configurável).
- **Max iterações por turno = 10**. Se exceder, emite `loop_limit_exceeded`, persiste estado parcial.
- **Timeout por tool call = 30s** (configurável globalmente; não por MCP server na v1).
- **Timeout total por turno = 5 min** wall-clock.

### D.3 — Cancelamento

`AbortController` no handler de stream propaga em cascata para LLM, MCP e RAG em voo. Mensagem parcial do assistant é **persistida** com `stopped_by_user = true`. Tool calls em voo são marcados como `cancelled` (categoria distinta de `error`).

### D.4 — Surfaceamento de erros

Três caminhos:

- **Tratável pelo LLM** (MCP 5xx, timeout específico, payload inválido): tool result vira `{ "error": "..." }`, LLM decide continuar ou parar.
- **Requer refresh de sessão** (MCP 401, JWT inválido detectado mid-stream): daemon emite `3: error { code: "mcp_credentials_expired", session_action: "refresh" }`, **marca a sessão como `stale`** em memória, fecha o stream. Próximos requests com aquele `sid` retornam 401 imediato sem chamar upstream.
- **Encerra turno limpo** (loop limit, total timeout): `3: error` com código específico, persiste parcial, fecha stream.

A marcação `stale` é crítica: sem ela, o usuário poderia retentar e o daemon ia bater no MCP que sabidamente vai retornar 401 de novo.

---

## 7. Cluster E — Invocação do RAG

- **RAG é uma tool que o LLM chama**: `retrieve(query, top_k?, index_filter?)`. Não há pré-injeção automática por turno.
- **Embedding da query:**
  - Se a config da sessão tem `embedding: { provider, api_key, model_id }`: augchatd embeda localmente e manda vetor pro backend (funciona para OpenSearch e pgvector).
  - Senão (só faz sentido com OpenSearch): augchatd usa neural query do OpenSearch com `model_id` da config. Sem embedding key em augchatd.
  - Para **pgvector**, `embedding` é obrigatório.
- **Formato do resultado:**
  ```jsonc
  {
    "results": [
      { "doc_id": "<opaque>", "title": "...", "snippet": "...", "score": 0.87, "source_index": "engineering-docs" }
    ]
  }
  ```
  augchatd não dereferencia `doc_id` — é opaco, escolhido pelo pipeline de ingestão do operador. UI/cliente decide se vira link.
- **OpenSearch hybrid:** usar a hybrid query nativa (RRF), com `search_pipeline` configurado do lado do cluster. Sem reinventar combinação BM25+kNN.
- **pgvector exige mapping explícito por tabela:**
  ```jsonc
  "tables": [
    { "name": "...", "id_column": "...", "title_column": "...", "content_column": "...", "vector_column": "..." }
  ]
  ```
  Sem template SQL custom (vetor de injection).
- **Enforcement de escopo: a config da sessão define o conjunto permitido; o LLM só pode filtrar para baixo.** Interseção é computada em augchatd; over-reach é logado.
- **Multi-index:** default é query paralela em todos os índices permitidos, mesclando por score; LLM pode estreitar via `index_filter`.

---

## 8. Cluster F — Protocolo `postMessage` (iframe ↔ parent)

### F.1 — Conjunto completo de mensagens

| Mensagem | Direção | Payload | Quando |
|---|---|---|---|
| `augchatd:ready` | iframe → parent | `{}` | UI montou |
| `augchatd:jwt` | parent → iframe | `{ jwt: string }` | Resposta à `ready` ou após `auth-required` |
| `augchatd:auth-required` | iframe → parent | `{ reason: "jwt_expired" \| "jwt_invalid" \| "mcp_credentials_expired" \| "session_revoked" }` | Algum 401 ou `mcp_credentials_expired`. Parent → backend → `POST /sessions` → novo JWT via `augchatd:jwt`. |
| `augchatd:resize` | iframe → parent | `{ height: number }` | Conteúdo cresceu/encolheu; parent opcionalmente ajusta `iframe.height`. |
| `augchatd:fatal` | iframe → parent | `{ code: string, message: string }` | Erro irrecuperável (incompatibilidade, config inválida). |

**Sem mensagens granulares por turno** (`message-sent`, `tool-called` etc.). Conteúdo de conversa não vaza para o parent.

### F.2 — Validação de origem no iframe

Parent declara sua própria origin via query string ao carregar o iframe:
```html
<iframe src="https://augchatd.your-infra/?parent_origin=https%3A%2F%2Fapp.acme.com"></iframe>
```
UI lê `parent_origin` da URL e só aceita `postMessage` com `e.origin` exatamente igual. Embedders maliciosos só conseguem declarar sua própria origin; mensagens reais carregam `e.origin` autêntica do browser.

### F.3 — CSP `frame-ancestors`

**V1: permissivo (`frame-ancestors *`).** JWT é a defesa real (UI sem JWT é inerte). Operador que precisa de restrição estrita pode pôr CSP mais apertado num reverse proxy. Per-tenant `allowed_embedding_origins` é uma evolução futura, quando houver mecanismo de config-por-tenant em outro lugar.

---

## 9. Cluster G — Processo e deploy

- **Compartilhamento entre tenants no mesmo processo:** HTTP/SSE pool global (sem isolamento); SQLite com 1 writer + N readers por tenant (WAL mode); JWT signing key global.
- **Limite de tenants ativos:** soft, limitado por FDs e memória de sessões. Documentar "centenas tranquilo; milhares exige tuning". Sem hard cap.
- **Isolamento de falha:** exceções por request são contidas; nada de `process.exit()` em error path normal.
- **Lifecycle do tenant:** SQLite aberto lazy na primeira sessão (ou no boot, se já existe). Fechado após **30 min** sem sessões ativas E sem flush pendente. Reabre lazy no próximo request. Arquivo nunca é destruído automaticamente.
- **Graceful shutdown** (SIGTERM):
  1. Para de aceitar novos requests.
  2. Não aceita novos turnos em streams já abertos (próxima request retorna `shutting_down`).
  3. Aguarda streams em voo, deadline 30s (configurável).
  4. Após deadline, força fechamento; mensagens parciais marcadas `stopped_by_shutdown`.
  5. Flush sincrônico de todas conversas hot pendentes.
  6. Fecha SQLite (commit + close), `exit 0`.
- **Sem `DELETE /tenants/{id}` na v1.** Decomissionamento é manual (stop + rm + s3 cleanup). Vira endpoint quando virar dor operacional.

---

## 10. Cluster H — Superfície de configuração

- **Process-level config: apenas env vars** (`AUGCHATD_LISTEN`, `AUGCHATD_TLS_CERT_FILE`, `AUGCHATD_TLS_KEY_FILE`, `AUGCHATD_CLIENT_CA_FILE`, `AUGCHATD_JWT_SIGNING_KEY_CURRENT`, `AUGCHATD_JWT_SIGNING_KEY_PREVIOUS?`, `AUGCHATD_HOT_DIR`, `AUGCHATD_MODE`, log level, TTLs, etc.). Sem arquivo de config até a lista crescer demais.
- **Materiais TLS** (três categorias):
  - Server cert/key (que o daemon apresenta).
  - Client CA bundle (que o daemon usa para validar mTLS de entrada).
  - JWT signing keys (já decidido em §4).
- **Recarga: restart-only na v1.** Sem SIGHUP hot reload — race conditions e infra moderna (cert-manager) já assume restart-on-rotate.
- **Demo mode env vars:**
  - Escalares: env var direta (`DEMO_MODEL_PROVIDER`, `DEMO_SYSTEM_PROMPT`, …).
  - Sub-objetos únicos: prefixo + nome (`DEMO_STORAGE_S3`, `DEMO_RAG_BACKEND`, `DEMO_RAG_CLUSTER`).
  - Listas de sub-objetos: **JSON inteiro como string**. Aplica a `DEMO_MCP_SERVERS='[...]'`, `DEMO_RAG_INDEXES='[{"name":"docs","content_field":"text"}]'` e `DEMO_RAG_TABLES='[...]'` (pgvector). Não há atalho CSV, porque cada item carrega schema específico (Cluster E). Quem demoniza com tools sofisticadas topa o JSON; quem só quer chat puro nem encosta nessas vars.
- **Demo mode constrói payload "como se" fosse `POST /sessions`** e roda pelo mesmo validador. Garante consistência entre demo e prod.
- **Demo permite omitir `DEMO_STORAGE_S3`:** roda só-hot (SQLite no `AUGCHATD_HOT_DIR`). Documentado: perde dados se apagar o volume. Prod sempre exige S3.

---

## 11. Cluster I — Observabilidade

- **Logs: JSON estruturado** para stderr, uma linha por evento. Campos obrigatórios: `level`, `ts`, `event`, `msg`. Campos contextuais quando aplicável: `tenant_id`, `session_id`, `conversation_id`, `tool_name`, `mcp_server_index`, `latency_ms`, `error_code`.
- **Endpoints operacionais:**
  - `GET /health` (sem mTLS): 200 se processo está vivo. Usado por liveness probe.
  - `GET /version` (sem mTLS): semver + git sha do build.
  - **Sem `/metrics` na v1** (operador pluga o que quiser; tipicamente sidecar OpenTelemetry).
- **Eventos sensíveis:**
  - **NUNCA em log:** corpo de mensagem, conteúdo de tool result, valor de credencial, URL de MCP server, snippets de RAG.
  - **SEMPRE em log:** identificadores, contagens, timings, códigos de erro categorizados.

---

## 12. Diagramas cross-cluster

### Fluxo de identidade

```
mTLS client cert (SAN URI)  ──►  tenant_id
                                    │
                                    │ POST /sessions { user_id, model, mcp_servers?, rag?, storage, ... }
                                    ▼
                              session_id (em memória)
                                    │   credenciais: LLM key, MCP tokens, RAG creds, S3 creds, embedding key
                                    │
                              JWT { aud: tenant_id, sub: user_id, sid: session_id, exp: ~10min }
                                    │
                                    │ postMessage augchatd:jwt
                                    ▼
                              browser/iframe
                                    │
                                    │ HTTP requests com Bearer JWT
                                    ▼
                              conversation_id (criado implícito na 1a msg, escopo (tenant_id, user_id))
                                    │
                                    ▼
                              SQLite por tenant (hot) → S3 por conversa (cold)
```

### Lifecycle de uma request de chat

```
POST /conversations/{id}/messages (JWT)
        │
        ├─ validar assinatura JWT (kid → current/previous)
        ├─ validar aud == tenant_id do route mTLS? não, sem mTLS aqui — JWT é a auth
        ├─ lookup sid em memória → recupera credenciais + escopo
        ├─ se sid stale → 401 (auth-required: mcp_credentials_expired)
        │
        ├─ hidratar conversation_id do S3 se não estiver hot
        ├─ append mensagem do usuário ao SQLite hot
        │
        ├─ stream open (Vercel AI SDK data stream)
        │
        │   loop tool-use:
        │     ├─ chamar LLM (Vercel AI SDK) → streaming tokens (0: text)
        │     ├─ se LLM emite tool_use:
        │     │     ├─ tools paralelos via Promise.all (cap 8)
        │     │     │     ├─ retrieve(...) → query backend RAG (escopo: interseção)
        │     │     │     └─ <mcp_tool>(...) → call MCP server (creds in-memory)
        │     │     ├─ emit 9: tool-call + a: tool-result (sanitizados)
        │     │     └─ feed results back to LLM
        │     ├─ se MCP 401 → marca sid stale, 3: error mcp_credentials_expired, close stream
        │     ├─ se loop_limit (10) → 3: error loop_limit_exceeded
        │     └─ se total_timeout (5min) → 3: error total_timeout
        │
        ├─ persistir mensagem do assistant ao SQLite hot
        └─ close stream
```

### Lifecycle do storage

```
mensagem nova ──► escrita imediata em SQLite hot (tenant_id.sqlite, row sem flushed_at)
                                    │
                                    │ (eventualmente)
                                    ▼
                          trigger de flush dispara:
                            - sessão evictada (TTL JWT+60s, ou DELETE /sessions/{id}), OU
                            - 5 min sem nova mensagem naquela conversa
                                    │
                                    ▼
                          flush por conversation_id:
                            1. ler todas mensagens da conversa do SQLite
                            2. PUT s3://.../<tenant>/<user>/<conv>/messages.ndjson (rewrite)
                            3. PUT s3://.../<tenant>/<user>/<conv>/meta.json
                            4. se sucesso: UPDATE flushed_at em todas as rows
                            5. se falha: backoff exp (cap 5min), retry — hot data preservado
                                    │
                                    ▼
                          GC pass (≥ 60s depois):
                            DELETE rows com flushed_at < now() - 60s
```

---

## 13. Itens explicitamente deferidos

São coisas conscientemente fora de escopo deste documento (e da v1, salvo nota):

- **CSP `frame-ancestors` configurável por tenant** (§F.3). Evolução futura quando houver mecanismo de config-por-tenant fora do payload de sessão.
- **`DELETE /tenants/{id}`** (§G). Manual por enquanto.
- **SIGHUP hot reload de TLS materials** (§H). Restart-only na v1.
- **Endpoint `/metrics`** (§I). Operador pluga via sidecar.
- **Hot reload de JWT signing key** sem restart (§B). Restart-only na v1; aguarda max JWT TTL para old key sair de uso.
- **Per-MCP timeout** (§D.2). Global na v1.
- **Per-tenant rate limiting** (README já declara fora de escopo).
- **`POST /sessions/{id}/jwt` ("renew JWT only")** (§A.4). Não existe — todo refresh é re-mint completo.

---

## 14. Schemas estimados (apenas como sanity check, não normativo)

Para confirmar que a forma cabe num SQLite por tenant. **Spec real do schema fica na Fatia 1.**

```sql
-- por tenant SQLite
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  default_model TEXT
);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  role             TEXT NOT NULL,    -- 'user' | 'assistant' | 'tool'
  content          TEXT NOT NULL,    -- JSON do content parts
  tool_calls       TEXT,             -- JSON, nullable
  model_id_used    TEXT,
  created_at       INTEGER NOT NULL,
  flushed_at       INTEGER,          -- nullable
  stopped_by_user  INTEGER DEFAULT 0,
  stopped_by_shutdown INTEGER DEFAULT 0
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_flush ON messages(flushed_at);
CREATE INDEX idx_conv_user ON conversations(user_id, updated_at);

CREATE TABLE tenant_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- ex.: ('tenant_san_uri', 'urn:augchatd-tenant:acme-corp')
--      ('schema_version', '1')
```

---

## 15. Próximos passos

1. Este documento é commitado.
2. Plano de implementação (skill `writing-plans`) é gerado **para a Fatia 1 (MVP demo)**, consumindo este documento como entrada arquitetural.
3. Specs subsequentes (Fatias 2–4) reusam este documento como cabeçalho arquitetural; cada uma escreve apenas a parte específica da fatia.
