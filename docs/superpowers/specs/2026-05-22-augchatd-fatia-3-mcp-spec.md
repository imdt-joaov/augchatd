# augchatd — Spec da Fatia 3 (cliente MCP end-to-end)

**Data:** 2026-05-22
**Status:** Aprovado (brainstorming concluído)
**Documento pai:** `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md` (decisões transversais).
**Specs anteriores:** `docs/superpowers/specs/2026-05-21-augchatd-fatia-1-mvp-demo-spec.md`, `docs/superpowers/specs/2026-05-22-augchatd-fatia-2-producao-spec.md` (forma e contratos que esta fatia herda).
**Plano de implementação:** a ser gerado em `docs/superpowers/plans/2026-05-22-augchatd-fatia-3-mcp.md`.
**Escopo deste documento:** congelar **o que** entrega a Fatia 3 — escopo, contratos externos novos/alterados, modelos de dados, critérios de aceite. **Não escopo:** ordem de implementação, código de exemplo, comandos shell (isso fica no plano).

---

## 1. Objetivo

Ativar MCP no augchatd. O loop tool-use do README passa a funcionar literalmente: o LLM consegue chamar tools de múltiplos MCP servers HTTP/SSE, cada um com credenciais por sessão; falhas categorizadas; 401 propaga como refresh de sessão; histórico de tool calls persiste e re-hidrata. Demo (Fatia 1) e prod (Fatia 2) continuam funcionando inalterados; MCP é opcional em ambos.

O que a Fatia 3 desbloqueia:
- A promessa central do README — *"per-user MCP credentials"* — sai do papel.
- Todos os dead code paths reservados desde a Fatia 1 (`SessionEntry.stale`, código 401 `mcp_credentials_expired`, coluna `tool_calls`, mapeamento `auth-required.reason='mcp_credentials_expired'`) ganham origem real.
- A Fatia 4 (RAG) herda a forma do tool-use loop pronta — RAG passa a ser "mais uma tool" e não um caminho separado.

O que a Fatia 3 **não** quer provar: RAG (Fatia 4). `tools.rag` continua rejeitado com 400 `unsupported_field`.

---

## 2. Escopo: o que entra

| Área | Decisão |
|---|---|
| Schema | `SessionPayloadSchema` ganha campo opcional `mcp_servers: McpServer[]`. Cada `McpServer = {label, url, auth, transport?}`. `tools.rag` continua rejeitado. |
| Transport | HTTP/SSE conforme MCP spec. Sem stdio. `transport: "sse" \| "streamable_http"`, default `"streamable_http"`. |
| Naming | `label` obrigatório, regex `^[a-z0-9_]{1,32}$`, único na lista. Tools expostos ao LLM como `<label>_<tool_name>`. |
| Auth | xor `{bearer: string}` ou `{headers: {[k]: string}}`. Validado por `z.union` discriminada. |
| Eager init | `POST /sessions` (prod) e boot do demo abrem todas as conexões MCP, chamam `initialize` + `tools/list`, cacheiam tools. Falha em qualquer server → 400 (prod) ou exit 1 (demo) com código categorizado. |
| Cliente MCP | Próprio (não `experimental_createMCPClient` do AI SDK). Tools traduzidos para AI SDK `tool({})` e passados em `streamText({ tools, maxSteps: 10 })`. |
| Loop | AI SDK roda o loop. `maxSteps = 10` (cap conta steps de LLM). Concorrência de tools paralelos dentro de um step capada a `AUGCHATD_MCP_PARALLEL_CAP` (default 8) via Promise pool. |
| Timeouts | Per-tool 30s (env `AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS`); total turn 5min (env `AUGCHATD_TURN_TIMEOUT_SECONDS`). Ambos via `AbortController`. |
| Cancelamento | `AbortSignal` do request HTTP propagado para AI SDK e para cada chamada MCP em voo. Tools cancelados → tool result com `status: 'cancelled'` (categoria distinta de erro). Mensagem parcial do assistant persistida com `stopped_by_user=1`. |
| Streaming | Eventos `9: tool-call` e `a: tool-result` do AI SDK passam por hook de sanitização que strip URL/headers/request_id/qualquer chave de transporte. Conteúdo de resultado (success) passa verbatim. Erros sempre categorizados (§4.7). |
| 401 mid-conversation | Marca `sid` como `stale`; emite `3: error { code: 'mcp_credentials_expired', detail: { server_label } }`; fecha stream. Próximas requests com aquele `sid` retornam 401 `mcp_credentials_expired` imediato (sem tocar upstream). |
| `mcp_unreachable` mid-turn | Tool result vira `{error: 'mcp_unreachable', server_label}`; LLM decide continuar. Conexão é re-tentada na próxima chamada (sem circuit breaker no nível MCP). |
| Persistência | Coluna `tool_calls` (já existente desde Fatia 1) ganha conteúdo. Cada LLM step com tools vira 1+ rows: 1 `role='assistant'` com `tool_calls` JSON; 1 row `role='tool'` por resultado. Hidratação pass-through (mesmo se o `label` não está mais provisionado na sessão atual). |
| Demo | `DEMO_MCP_SERVERS`: JSON string do mesmo array `mcp_servers` do prod. Eager init no boot; falha = exit 1 com código categorizado. |
| Observabilidade | Eventos novos: `mcp.connect.start`, `mcp.connect.ok`, `mcp.connect.failed`, `mcp.tools_list`, `mcp.tool_call.start/ok/error/cancelled`, `mcp.401.session_marked_stale`. Campos seguros (`tenant_id`, `session_id`, `conversation_id`, `server_label`, `tool_name`, `latency_ms`, `error_code`); **nunca** URL, headers, conteúdo de result. |

---

## 3. Escopo: o que NÃO entra

- **RAG (Fatia 4).** `tools.rag` continua rejeitado com 400 `unsupported_field`.
- **MCP prompts, resources, sampling.** Só `tools/list` + `tools/call`. Outras capabilities anunciadas pelo server são ignoradas silenciosamente.
- **MCP stdio.** HTTP/SSE only; operador wrap'a stdio em HTTP via `mcpo` ou similar.
- **OAuth dance dentro do augchatd.** Backend do operador faz a dance e passa bearer/header pronto. Refresh é via re-mint de sessão (`POST /sessions` novo), igual JWT.
- **Per-MCP timeout customizado.** Timeout global; per-server vira env futura quando virar dor.
- **Cache compartilhado de conexões MCP entre sessões.** Mesmo se duas sessões apontam para o mesmo URL com auth idêntico, cada sessão abre suas próprias conexões. Compartilhar misturaria isolamento de credenciais com baixo ganho.
- **Retry automático em transport flake.** Conexão que cai mid-turn → chamada em voo retorna `mcp_unreachable`; LLM decide. Próxima chamada reabre. Sem replay de tool calls.
- **Backoff cache de servers "mortos".** Cada `tools/call` tenta o transport; sem circuit breaker.
- **Sanitização de conteúdo de tool result (success).** Pass-through verbatim — responsabilidade do operador.
- **Schema migration na SQLite.** A coluna `tool_calls` já existe desde Fatia 1; `schema_version='1'` permanece.
- **Multi-server tool composition / chained calls explícitos.** O LLM compõe via diálogo turn-to-turn; augchatd não orquestra workflows multi-tool.
- **Per-tool concurrency limit por server.** Cap global se aplica ao step inteiro; mesmo se 8 tools paralelos vão todos pro mesmo MCP server, é tarefa do operador suportar isso.
- **CSP `frame-ancestors` per-tenant, `/metrics`, hot reload de JWT/TLS, `DELETE /tenants/{id}`, single-binary `bun build --compile`.** Permanecem deferidos como nas Fatias 1 e 2.

---

## 4. Contratos externos

Tudo nesta seção é **público e congelado** ao fim da Fatia 3. Mudanças quebram backends operadores ou a UI bundled. Trocas de forma exigem revisão explícita.

### 4.1 Variáveis de ambiente (deltas vs Fatia 2)

#### 4.1.1 Process-level (`AUGCHATD_*`)

| Variável | Obrigatória | Default | Notas |
|---|---|---|---|
| `AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS` | não | `30` | int positivo; aplicado a cada `tools/call` individual |
| `AUGCHATD_TURN_TIMEOUT_SECONDS` | não | `300` | int positivo; wall-clock do turno inteiro (cobre o loop tool-use completo) |
| `AUGCHATD_MCP_PARALLEL_CAP` | não | `8` | int positivo; concorrência máxima de tools paralelas dentro de um step |

Nenhuma var é renomeada ou removida. Tudo de Fatia 1/2 segue válido.

#### 4.1.2 Demo (`DEMO_*`)

| Variável | Obrigatória | Default | Notas |
|---|---|---|---|
| `DEMO_MCP_SERVERS` | não | — | JSON string de array `McpServer[]` (mesmo schema do payload prod). Ausente = sessão demo sem MCP. Boot falha (exit 1 com `mcp_init_failed: <code>, server_label=<label>`) se JSON inválido ou eager init falhar. |

### 4.2 Endpoints HTTP

**Nenhum endpoint novo.** Mudanças de comportamento nos existentes:

| Endpoint | Mudança |
|---|---|
| `POST /sessions` (CONTROL, mTLS) | Aceita `mcp_servers` opcional no payload. Após validação Zod e smoke test S3, executa eager init em cada MCP server (sequencial, fail-fast). Sucesso → JWT mintado normal. Falha → 400 com código categorizado (§4.5); sessão não é criada. |
| `POST /conversations/{id}/messages` (DATA, JWT) | Loop tool-use pode emitir eventos `9: tool-call`, `a: tool-result`, `3: error` (códigos MCP) além dos `0/1` de texto. Se sessão `stale`, retorna 401 `mcp_credentials_expired` antes de tocar LLM. |
| `DELETE /sessions/{id}` (CONTROL, mTLS) | Além de evictar entrada em memória e enfileirar flush (Fatia 2), agora fecha todas as conexões MCP da sessão (idempotente: connection ja fechada = no-op). |

### 4.3 JWT e códigos 401

**Forma do JWT inalterada.** Códigos 401 do middleware:

| Código | Quando | Mudança vs Fatia 2 |
|---|---|---|
| `auth_required` | header `Authorization` ausente/malformado | — |
| `auth_invalid` | JWT mal-formado, assinatura/`kid`/`aud` ruins | — |
| `session_not_found` | `sid` válido cripto mas entrada em memória sumiu | — |
| `mcp_credentials_expired` | sessão marcada `stale` | **Deixa de ser dead code path.** Marcação real ocorre quando MCP retorna 401 em qualquer chamada (`initialize`, `tools/list`, ou `tools/call`). |

Mapeamento UI → `auth-required.reason` permanece o da Fatia 1.

### 4.4 Schema `mcp_servers` no `SessionPayloadSchema`

```typescript
const McpAuthSchema = z.union([
  z.object({ bearer: z.string().min(1) }).strict(),
  z.object({
    headers: z.record(
      z.string().regex(/^[A-Za-z0-9_-]+$/),
      z.string()
    ).refine(h => Object.keys(h).length >= 1, { message: 'headers must be non-empty' }),
  }).strict(),
]);

const McpServerSchema = z.object({
  label:     z.string().regex(/^[a-z0-9_]{1,32}$/),
  url:       z.string().url(),
  auth:      McpAuthSchema,
  transport: z.enum(['sse', 'streamable_http']).default('streamable_http'),
}).strict();

const SessionPayloadSchema = z.object({
  user_id:       z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model:         /* inalterado */,
  storage:       /* inalterado */,
  mcp_servers:   z.array(McpServerSchema).optional().refine(
    arr => !arr || new Set(arr.map(s => s.label)).size === arr.length,
    { message: 'mcp_servers labels must be unique' }
  ),
}).strict();
```

Regras:
- `auth` é xor estrito: exatamente um de `{bearer}` ou `{headers}`. Os dois juntos → `validation_error`.
- Header names: `[A-Za-z0-9_-]+` (sem espaços, sem chars que browsers/proxies podem comer). Impede injection de `\r\n` no header serialization.
- `headers` deve ter ao menos uma entrada (senão use bearer ou nada).
- `mcp_servers` é opcional. Ausente ou `[]` → sessão sem MCP, comportamento idêntico à Fatia 2.
- `label` único na lista; duplicata → `validation_error` com `detail.field='mcp_servers.label'`.
- Campo desconhecido em qualquer nível → `unsupported_field` (já existe via `.strict()`).
- `tools.rag` (key `tools` no root) continua rejeitado como `unsupported_field`.

### 4.5 Códigos de erro de control plane (deltas)

Adicionados aos códigos da Fatia 2. Todos retornam 400; nenhum carrega URL completa, headers ou segredos.

| Código | Quando | `detail` |
|---|---|---|
| `mcp_unreachable` | `initialize` ou `tools/list` falhou por transport (DNS, connect refused, TLS handshake, timeout) | `{ server_label, kind: 'dns' \| 'connect' \| 'tls' \| 'timeout' }` |
| `mcp_credentials_expired` | `initialize` retornou 401 ou WWW-Authenticate equivalente | `{ server_label }` |
| `mcp_invalid_tools_schema` | `tools/list` retornou OK mas algum tool tem schema inválido (Zod parse falhou) | `{ server_label, tool_name, issue }` (issue = string curta sem dump do schema) |
| `mcp_protocol_error` | Resposta MCP viola protocolo (versão de protocolo incompatível, mensagem mal-formada, capabilities sem `tools`) | `{ server_label, kind: 'version_mismatch' \| 'malformed' \| 'no_tools_capability' }` |

### 4.6 Protocolo `postMessage`

**Inalterado.** As 5 mensagens (`augchatd:ready`, `augchatd:jwt`, `augchatd:auth-required`, `augchatd:resize`, `augchatd:fatal`) permanecem. Validação por `parent_origin` inalterada. O caminho `auth-required.reason='mcp_credentials_expired'`, mapeado desde Fatia 1, agora tem origem real (401 do middleware quando sessão `stale`).

### 4.7 Eventos no stream — sanitização e códigos

A Fatia 1 só usava `0: text-delta` (e equivalentes de assistant-ui). A Fatia 3 ativa `9: tool-call`, `a: tool-result` e mais códigos em `3: error`.

#### Eventos de tool

| Evento | Payload emitido | Strip pela sanitização |
|---|---|---|
| `9: tool-call` | `{ tool_call_id, tool_name: '<label>_<original>', args }` | qualquer chave `url`, `headers`, `request_id`, `mcp_*_internal_*` adicionada pelo AI SDK ou pelo nosso código |
| `a: tool-result` (success) | `{ tool_call_id, result: <pass-through verbatim>, status: 'ok' }` | mesmo set; nunca toca em `result` |
| `a: tool-result` (error) | `{ tool_call_id, error: { code, server_label }, status: 'error' }` | só `code` categorizado vai; mensagem upstream raw nunca |
| `a: tool-result` (cancelled) | `{ tool_call_id, status: 'cancelled' }` | — |

Códigos possíveis em `a: tool-result` com `status: 'error'` (cada um tem `detail: { server_label }`):

| Código | Quando |
|---|---|
| `mcp_unreachable` | transport falhou (DNS, connect refused, TLS, conexão derrubada mid-call) |
| `mcp_timeout` | `tools/call` excedeu `AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS` |
| `mcp_5xx` | server retornou HTTP 5xx ou erro JSON-RPC equivalente |
| `mcp_invalid_response` | resposta mal-formada (payload não-JSON, não casa schema esperado de `tools/call`) |

Tool results com `status: 'error'` ou `'cancelled'` **não fecham stream**; o LLM decide se continua.

#### Códigos categorizados em `3: error` (mid-stream, fecham stream)

| Código | Quando | `detail` | Efeito colateral |
|---|---|---|---|
| `mcp_credentials_expired` | qualquer chamada MCP retornou 401 mid-turn | `{ server_label }` | sessão marcada `stale`; parcial persistido |
| `loop_limit_exceeded` | AI SDK atingiu `maxSteps=10` sem terminar | `{}` | parcial persistido |
| `total_timeout` | turn ultrapassou `AUGCHATD_TURN_TIMEOUT_SECONDS` | `{}` | parcial persistido (sem flag de user — é timeout, não cancelamento explícito) |
| `llm_rate_limited` | provider LLM retornou 429 ou equivalente | `{}` | parcial persistido |

#### Os três contextos de `mcp_credentials_expired`

Mesmo nome, três entradas no contrato — distintas pelo HTTP status e pelo timing:

| Contexto | HTTP status | Quando | Ação esperada do operador |
|---|---|---|---|
| `POST /sessions` (eager init) | 400 | `initialize` retornou 401 | backend refresca credenciais antes de re-tentar `POST /sessions` |
| `3: error` mid-stream | (no body do data stream, stream open com `Content-Type: text/plain`) | `tools/call` retornou 401 | UI emite `auth-required.reason='mcp_credentials_expired'` → backend re-minta sessão |
| Requests subsequentes na sessão `stale` | 401 | qualquer request com `sid` marcado stale | igual ao anterior |

---

## 5. Modelos de dados

### 5.1 SQLite por tenant (sem mudança de schema)

Schema da Fatia 1/2 permanece intacto. `schema_version='1'`. As colunas que eram dead code path agora ganham significado real:

- `messages.tool_calls`: JSON da lista de tool calls emitidas no step. Forma (uma entrada por call):
  ```jsonc
  [
    {
      "tool_call_id": "<id from llm>",
      "tool_name":    "<label>_<original_name>",
      "args":         { ... }
    }
  ]
  ```
  NULL em mensagens sem tools (continua valendo para Fatia 2-style).

- Resultados de tools vivem em **rows separadas** `role='tool'`. Forma de `content` (JSON):
  ```jsonc
  {
    "tool_call_id": "<matches assistant row>",
    "status":       "ok" | "error" | "cancelled",
    "result":       <pass-through, se status=ok>,
    "error":        { "code": "<mcp_*>", "server_label": "..." }   // se status=error
  }
  ```
  Uma row de `role='tool'` por tool call. `tool_calls` column NULL nessas rows.

- `model_id_used`: continua sendo o modelo que rodou esse step específico.
- `stopped_by_user=1`: marcado em parciais de assistant quando user cancela o stream (já era código Fatia 1 reservado; agora flow real).
- `stopped_by_shutdown=1`: marcado em parciais quando deadline de graceful shutdown estoura (já era Fatia 2).

### 5.2 Entrada em memória da sessão (`SessionEntry`)

Adiciona campos para MCP. Existing fields da Fatia 2 inalterados:

```typescript
interface SessionEntry {
  tenantId: string;
  userId:   string;
  modelProvider: 'anthropic';
  modelId:       string;
  modelApiKey:   string;
  systemPrompt:  string;
  storage:       /* inalterado Fatia 2 */;
  expiresAt:     number;
  stale:         boolean;        // marcado por MCP 401 (Fatia 3 origem real)
  createdAt:     number;
  conversationsTouched: Set<string>;

  // novo em Fatia 3:
  mcpClients: Map<string /* label */, McpClientHandle>;
}

interface McpClientHandle {
  label:     string;
  url:       string;          // ⚠ nunca exposto em log ou stream
  transport: 'sse' | 'streamable_http';
  authMode:  'bearer' | 'headers';   // só o modo, não o valor
  tools:     McpToolDef[];    // snapshot de tools/list, cacheado para a sessão
  client:    McpClient;       // handle do client transport-level
  closed:    boolean;
}

interface McpToolDef {
  name:        string;          // original do server
  exposedName: string;          // `${label}_${name}`
  description: string | undefined;
  inputSchema: ZodType;         // compilado de tools/list[*].inputSchema
}
```

Lifecycle:
- Criado em `POST /sessions` (ou boot do demo) após eager init bem-sucedido. Falha de init = não cria entrada.
- `markStale(sid)` flipa `stale=true`. Chamado por qualquer 401 detectado em `tools/call` mid-stream.
- `evict(sid)` (TTL natural, `DELETE /sessions/{id}`, ou shutdown) chama `client.close()` em cada handle, marca `closed=true`. Idempotente.

### 5.3 `SessionPayloadSchema` (Fatia 3)

Vide §4.4. Mudança real é só adicionar `mcp_servers` opcional. Demo continua aplicando `.partial({storage: true})` antes de validar (Fatia 2); `mcp_servers` segue a mesma regra de "opcional em demo, opcional em prod".

### 5.4 Layout NDJSON em S3 (deltas)

Schema da linha de message em `messages.ndjson` ganha conteúdo nos campos já presentes:

```jsonc
{ "id": "<uuid>", "role": "assistant",
  "content": "<text parcial ou completo>",
  "tool_calls": [ { "tool_call_id": "...", "tool_name": "label_x", "args": {...} } ],
  "created_at": 1716300000000, "model_id_used": "claude-opus-4-7",
  "stopped_by_user": false, "stopped_by_shutdown": false }
```

E rows `role='tool'` aparecem normalmente:
```jsonc
{ "id": "<uuid>", "role": "tool",
  "content": "{\"tool_call_id\":\"...\",\"status\":\"ok\",\"result\":{...}}",
  "tool_calls": null,
  "created_at": 1716300000050, "model_id_used": null,
  "stopped_by_user": false, "stopped_by_shutdown": false }
```

`content` é sempre string (mesmo quando o payload semântico é objeto JSON) — escolha de Fatia 1 mantida (a coluna SQLite é TEXT). Reader interpreta `content` como JSON quando `role='tool'`.

Hidratação cold → hot da Fatia 2 funciona sem mudança: rows são copiadas verbatim, `flushed_at` preenchido.

### 5.5 Reconstrução de contexto para o LLM (hidratação → AI SDK messages)

Quando uma conversa é continuada, o handler converte as rows SQLite para o formato `ModelMessage` do AI SDK:

- `role='user'`: `{ role: 'user', content: <string> }`.
- `role='assistant'` sem `tool_calls`: `{ role: 'assistant', content: <string> }`.
- `role='assistant'` com `tool_calls`: `{ role: 'assistant', content: [{type:'text', text:<content>}, ...tool_calls como toolUse parts] }`.
- `role='tool'`: `{ role: 'tool', content: [{ type: 'tool-result', toolCallId, output: <result|error> }] }`.

Pass-through verbatim: se `tool_name='github_search'` aparece no histórico mas a sessão atual só tem `linear_*`, o tool ainda é enviado na mensagem assistant — o LLM apenas não terá `github_search` no `tools={}` desta sessão e portanto não pode chamá-lo de novo. AI SDK não rejeita histórico com tool names não presentes em `tools={}`.

---

## 6. Loop tool-use end-to-end

Vista do que um turno faz, do POST de mensagem ao close do stream:

```
POST /conversations/{id}/messages  (JWT)
        │
        ├─ middleware JWT: valida assinatura + lookup sid → SessionEntry
        │      └─ se entry.stale → 401 mcp_credentials_expired (sem tocar LLM nem MCP)
        │
        ├─ se conversa não está hot → hidratação cold→hot (Fatia 2)
        ├─ append mensagem do user ao SQLite hot
        │
        ├─ montar tools = { ...for each McpClientHandle, for each tool: <label>_<name> → ai-sdk tool({}) }
        │      execute(args, { abortSignal }) →
        │         1. acquire slot do Promise pool (cap = AUGCHATD_MCP_PARALLEL_CAP)
        │         2. setTimeout AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS dispara local AbortController
        │         3. client.callTool({ name, args, signal: combined(abortSignal, localAbort) })
        │         4. mapear resposta:
        │            - sucesso → { status: 'ok', result }
        │            - MCP 401 → throw McpUnauthorizedError (handler exterior marca stale)
        │            - MCP 5xx / malformed → { status: 'error', error: { code:'mcp_5xx'|'mcp_invalid_response', server_label } }
        │            - transport / DNS / connect / TLS → { status: 'error', error: { code:'mcp_unreachable', server_label } }
        │            - timeout local → { status: 'error', error: { code:'mcp_timeout', server_label } }
        │            - signal aborted → { status: 'cancelled' }
        │
        ├─ AbortController total (AUGCHATD_TURN_TIMEOUT_SECONDS) + signal do request HTTP
        │
        ├─ streamText({ model, system, messages, tools, maxSteps: 10, abortSignal })
        │      onChunk hook → sanitiza payload (strip url/headers/request_id) antes do flush
        │      onStepFinish → persiste row(s) no SQLite hot:
        │         - assistant step com tool_calls? → 1 row role='assistant' com tool_calls JSON
        │         - cada tool result do step → 1 row role='tool'
        │      onFinish → persiste row final role='assistant' (texto) se houver
        │
        ├─ error handler:
        │      McpUnauthorizedError → markStale(sid); emit 3:error mcp_credentials_expired; close
        │      AI SDK MaxStepsExceededError → emit 3:error loop_limit_exceeded; persist parcial; close
        │      AbortError com cause=turnTimeout → emit 3:error total_timeout; persist parcial; close
        │      AbortError com cause=clientAbort → persist parcial com stopped_by_user=1; close
        │      LLM rate limit → emit 3:error llm_rate_limited (categorizado, sem detalhe bruto); close
        │
        └─ close stream
```

**Concorrência:** o `execute()` de cada tool dentro de um step é envolvido por um Promise pool global ao turno. AI SDK chama todos em paralelo (`Promise.all`); nosso pool serializa para ≤ `AUGCHATD_MCP_PARALLEL_CAP` ativos.

**Sanitização:** uma única função `sanitizeChunk(chunk)` aplicada antes de qualquer flush. Strip recursivo de keys conhecidas (`url`, `endpoint`, `headers`, `request_id`, `traceparent`, `x-*-internal-*`). Para garantir, é o caminho **único** de saída do stream — qualquer event passa por ela.

**Idempotência de marcação `stale`:** múltiplas chamadas paralelas que retornam 401 ao mesmo tempo → `markStale` é no-op após o primeiro. O primeiro emite o evento `3: error`; subsequentes são absorvidos.

---

## 7. Mapeamento Cluster → Fatia 3

| Cluster | Entrega na Fatia 3 | Diferido a |
|---|---|---|
| **A.1** SAN URI = tenant_id | Inalterado vs Fatia 2 | — |
| **A.2** Claims do JWT | Inalterado | — |
| **A.3** Conversation lifecycle | Inalterado | — |
| **A.4** GC sessão + refresh + DELETE | **Marcação `stale` ganha origem real** (MCP 401); evicção fecha MCP clients além do que já fazia | — |
| **B** Rotação de chave JWT | Inalterado | — |
| **C.1–C.3** Storage hot/cold | Inalterado; `tool_calls` agora não-nulo afeta NDJSON apenas no preenchimento | — |
| **D.1** Streaming + sanitização | **Implementado completo:** eventos 9/a com sanitização; códigos 3:error MCP/loop/timeout ativos | — |
| **D.2** Paralelismo + limites | Promise pool cap 8; maxSteps=10; per-tool 30s; total turn 5min | per-MCP timeout → futuro |
| **D.3** Cancelamento | `AbortSignal` em cascata; tools cancelled como categoria distinta; `stopped_by_user=1` em parcial | — |
| **D.4** Categorias de erro | `mcp_credentials_expired`, `mcp_unreachable`, `mcp_5xx`, `mcp_timeout`, `mcp_invalid_response`, `loop_limit_exceeded`, `total_timeout`, `llm_rate_limited` | — |
| **E** RAG | — | Fatia 4 |
| **F.1–F.3** postMessage | Inalterado; `mcp_credentials_expired` agora tem origem | per-tenant CSP → futuro |
| **G** Processo + deploy | Graceful shutdown agora também fecha MCP clients pendentes | — |
| **H** Config | 3 envs novas (timeout per-tool, turn, parallel cap); `DEMO_MCP_SERVERS` ganha implementação | — |
| **I** Observabilidade | Eventos `mcp.*` adicionados; payloads continuam livres de URL/headers/conteúdo | `/metrics` → futuro |

---

## 8. Critérios de aceite

A Fatia 3 está "pronta" quando **todos** os itens abaixo são verificáveis:

- [ ] `bun test` passa (unit + e2e in-process; e2e cobre MCP server mock HTTP/SSE para `initialize`, `tools/list`, `tools/call`, 401 path, transport failure).
- [ ] `bun run build` (backend + UI) sem warnings de tipo.
- [ ] `docker build -t augchatd:dev .` completa.
- [ ] **Demo com MCP real:** `docker run -e DEMO_MCP_SERVERS='[{"label":"weather","url":"https://...","auth":{"bearer":"..."}}]' ...`; UI envia "what's the weather in NYC"; LLM chama `weather_*`, response streamada com tool call + result visíveis e sem URL/headers vazados.
- [ ] **Demo sem MCP:** comportamento Fatia 1 inalterado.
- [ ] **Prod com MCP:** `curl --cert ... POST /sessions` com `mcp_servers`; eager init exitoso → 200 com JWT; tool call de fato chega ao MCP com bearer correto.
- [ ] **Falha de eager init (prod):** MCP URL inválido / 401 / schema ruim → 400 categorizado em < 5s; resposta não vaza secret nem URL.
- [ ] **Falha de eager init (demo):** mesma condição → daemon faz exit 1 com mensagem categorizada.
- [ ] **MCP 401 mid-stream:** simular 401 num `tools/call` em conversa em andamento → stream fecha com `3: error mcp_credentials_expired`; próxima request com mesmo JWT retorna 401 `mcp_credentials_expired`; novo `POST /sessions` (cliente refresh) restaura.
- [ ] **MCP unreachable mid-stream:** matar o MCP mock no meio de um tool call → tool result vira `mcp_unreachable`; LLM continua (não fecha stream); persistência mostra row `role='tool'` com error.
- [ ] **Cancelamento:** UI fecha stream mid-tool-call → mensagem parcial persistida `stopped_by_user=1`; tool em voo registrado com `status='cancelled'`; chamada MCP recebeu AbortSignal.
- [ ] **Loop limit:** força LLM (via prompt adversarial ou mock) a entrar em loop de tool calls → após `maxSteps=10`, stream fecha com `loop_limit_exceeded`; parcial persistido.
- [ ] **Continuidade com mcp_servers diferentes:** conversa salva com `tool_calls` de `github_*`; nova sessão sem `mcp_servers` (ou com `linear` em vez de `github`); abre conversa, manda mensagem nova → contexto LLM inclui histórico verbatim; LLM não tenta chamar `github_*`; turn completa.
- [ ] **Multi-tenant inalterado:** dois tenants com MCP configs distintos não compartilham nada (smoke test multi-tenant da Fatia 2 continua passando, agora com MCP em cada).
- [ ] **Graceful shutdown:** SIGTERM mid-tool-call → tool call termina ou aborta dentro do deadline; conexões MCP fecham; flush sincrônico inclui rows com `tool_calls`.

Não-critérios (não bloqueiam):
- Publicação Docker, README atualizado.
- Suporte a MCP `prompts`/`resources`/`sampling` (Fatia futura).
- Métricas de tools (`/metrics` continua deferido).

---

## 9. Decisões deferidas explicitamente

| Item | Por que fora da Fatia 3 |
|---|---|
| RAG (Fatia 4) | Schema ainda rejeita `tools.rag`. Pronto para virar tool no Fatia 4 sob o mesmo framework. |
| MCP prompts/resources/sampling | Cada um tem padrão de uso próprio (UI suggestion, context augmentation, bidirectional). Sem demanda concreta ainda. |
| MCP stdio | HTTP/SSE only é decisão de produto. Wrap via mcpo é o caminho. |
| OAuth dance interno | Backend do operador faz; augchatd é stateless quanto a refresh. |
| Per-MCP timeout customizado | Global suficiente para v1. Vira env por-server quando virar dor. |
| Circuit breaker / backoff cache de MCP servers mortos | Adiciona estado complexo de manter coerente; LLM já lida com `mcp_unreachable` voltando como tool result. |
| Compartilhar conexões MCP entre sessões | Mistura isolamento de credenciais; ganho pequeno. |
| Retry automático de tool call em transport flake | LLM decide; replay seria semanticamente arriscado (idempotência desconhecida). |
| Sanitização de URLs/segredos em tool result success | Responsabilidade do operador; sanitizar quebraria caso de uso legítimo (e.g., MCP que devolve link). |
| Per-tool concurrency limit por server | Cap global suficiente. |
| Cap explícito de número de tools ou de tamanho de result | Token budget do LLM é o cap natural. |
| `/metrics` endpoint | Continua via sidecar OTel. |
| Hot reload de JWT/TLS | Restart-only. |
| CSP `frame-ancestors` per-tenant | Sem mecanismo de config-per-tenant fora do payload. |
| `DELETE /tenants/{id}` | Manual continua aceitável. |
| Single-binary `bun build --compile` | Docker é suficiente. |

---

## 10. Próximos passos

1. Esta spec é commitada.
2. Plano de implementação é gerado em `docs/superpowers/plans/2026-05-22-augchatd-fatia-3-mcp.md` via skill `writing-plans`, consumindo esta spec + o arch doc + as specs das Fatias 1 e 2 como entrada.
3. Execução do plano segue via `subagent-driven-development` ou `executing-plans`. **Pré-requisito:** Fatia 2 implementada e mergeada (esta fatia herda eager-init pattern do `POST /sessions`, sanitization de streaming, e session lifecycle — todos da Fatia 2).
4. Específicos para corrigir no README após Fatia 3 mergeada (não bloqueante): documentar `label` obrigatório em `mcp_servers`, modos de auth aceitos (`bearer` xor `headers`), envs novas (`AUGCHATD_MCP_*`, `AUGCHATD_TURN_TIMEOUT_SECONDS`), e que `tools.rag` ainda é rejeitado.
