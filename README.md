# augchatd

*augmented chat daemon — chat augmented with your users' own tools (MCP) and their own data (RAG), enforced per session.*

> Per-user MCP credentials and per-user RAG scoping for LLM chat in your app. Provisioned by your existing auth at session creation. Never exposed to the browser.

```bash
# Your backend, once per chat session:
curl -X POST https://augchatd.your-infra:8443/sessions \
  --cert prod-client.pem --key prod-client.key \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id":     "user_42",
    "ttl_seconds": 60,
    "system_prompt": "You are a helpful assistant.",
    "model":       { "provider": "anthropic", "model_id": "claude-opus-4-7", "api_key": "sk-ant-..." },
    "connectors": [
      { "descriptive_id": "rag_public",  "name": "Public docs",         "type": "rag", "default_active": true,
        "backend": "opensearch", "cluster": "https://your-opensearch/", "auth": { "bearer": "..." }, "indexes": ["public-docs"] },
      { "descriptive_id": "mcp_github",  "name": "GitHub (user OAuth)", "type": "mcp", "default_active": true,
        "url": "https://your-mcp/", "auth": { "bearer": "..." } }
    ],
    "storage":     { "s3": { "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "your-bucket", "access_key_id": "AKIA...", "secret_access_key": "..." } }
  }'
# → { "session_id": "...", "jwt": "eyJ...", "expires_at": "..." }
```

```html
<!-- In your app: embed augchatd's bundled UI, then hand it the JWT. -->
<iframe id="chat" src="https://augchatd.your-infra/"></iframe>
<script>
  // augchatd's UI posts {type:'augchatd:ready'} when booted; reply with the JWT.
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://augchatd.your-infra') return;
    if (e.data?.type === 'augchatd:ready') {
      document.getElementById('chat').contentWindow.postMessage(
        { type: 'augchatd:jwt', jwt: jwtFromYourBackend },
        'https://augchatd.your-infra'
      );
    }
  });
</script>
```

`ttl_seconds` is the JWT lifetime (optional, default `60`). The low default is deliberate for development — it forces frequent refresh through your backend so the refresh path stays exercised. In production, raise it (e.g. `1800` for 30 min) to amortize refresh latency.

`connectors[]` is the unified list of tools and retrieval providers attached to the session. Each entry carries:

- `descriptive_id` — unique within the session; used to address the connector (e.g. for toggling) and in tool-call indicators.
- `name` — human-friendly label shown in the bundled UI.
- `type` — `"mcp"` or `"rag"` (extensible).
- `default_active` — initial active state; some entries may be provisioned but default off.
- type-specific fields: `url` + `auth` for `mcp`; `backend` (currently only `"opensearch"` — hybrid BM25 + kNN; pgvector is a future option), `cluster`, `auth`, `indexes[]` for `rag`.

The list is optional; minimal session is `model + storage`. Once the session is live, the bundled UI lets the **end user toggle individual connectors on/off per conversation** (`PUT /conversations/:cid/connectors/:descriptive_id`). The toggle is saved with the conversation, so it survives JWT refresh, idle flush, and forced re-mint — and different conversations of the same user have independent toggle state. The end user can only **narrow** the integrator's resolved scope (turn entries off) — they cannot add a connector. Adding requires a new session.

The browser never sees the LLM key, the MCP credentials, the RAG cluster, or the storage credentials. Only your server-issued JWT, valid for minutes. The chat UI is bundled in the augchatd binary and served on the same origin as the API — built on [assistant-ui](https://github.com/assistant-ui/assistant-ui), shipped with the daemon, no separate UI to host.

A **session** is the short-lived authenticated context a `POST /sessions` call mints — its lifetime equals the JWT TTL. A **conversation** is the persistent chat history identified by `conversation_id` and can span any number of sessions: when a JWT expires mid-chat, the next session resumes the same conversation from storage. Your backend mints sessions; the browser creates and chooses conversations directly against augchatd.

## The problem augchatd solves

In a B2B SaaS, different users get different tools, different data, and sometimes different LLM tiers. Building this on top of the Vercel AI SDK (or any LLM library) means hand-rolling:

- A **token vault** so each user's GitHub/Slack/Linear OAuth tokens are stored and routed to *their* MCP calls — and never leak across users.
- A **per-request MCP router** that picks the right credentials for the user behind the current message.
- A **RAG query scoper** that constrains every retrieval to the indexes that user is allowed to see, *before* the LLM gets a chance to ask for the wrong one.
- An **OAuth refresh layer** that renews tokens before they expire mid-conversation.

augchatd is the contract that lets your existing auth provision all of this per session, and enforces it for every message. Concretely:

- `user_42` chats with the GitHub MCP using their own OAuth token; `user_99` uses theirs. Neither ever sees the other's credential.
- `user_42` can search the `engineering-docs` and `private-42` indexes; `user_99` only sees `sales-docs`. Retrieval is scoped before the LLM asks.
- `user_42` brings their own Anthropic key (enterprise tier); `user_99` runs on your shared free-tier key. Billing and rate limits stay where they already live — with the provider, per key.

If you've spent two weeks gluing a per-user MCP behind the AI SDK and lost confidence you didn't leak somewhere, this is the part you don't want to own.

## Quick Start (demo mode)

Try augchatd end-to-end without standing up a control plane or mTLS infrastructure. Demo mode loads a single fixed session from a JSON file on disk — the same shape an integrator would `POST` to `/sessions` in production, just read from a file instead of an HTTPS body.

```bash
# 1. Copy the template and fill in your model API key (+ optional S3 + connectors).
cp local/demo_session.json.example local/demo_session.json
${EDITOR:-vi} local/demo_session.json

# 2. Boot.
docker run -p 8080:8080 \
  -e AUGCHATD_MODE=demo \
  -v "$PWD/local/demo_session.json:/app/local/demo_session.json:ro" \
  augchatd/augchatd   # image TBD — not yet published

open http://localhost:8080/demo/
```

The JSON carries the model provider + key, system prompt, optional S3 credentials (omit for hot-only — history lost on restart, fine for local demos), and optional `connectors[]` (typed MCP / RAG, same shape as the production payload). `GET /demo/` serves a small "fake integrator" wrapper that runs the same iframe + postMessage handshake an integrator does in production — it `POST`s `/demo/sessions` for the JWT and hands it to the iframe.

Working from a checkout instead of docker? `./run-dev-local.sh` boots the same path against the same file. See [CONTRIBUTING.md](CONTRIBUTING.md) → "Local development".

Demo mode is for local testing and public demos only. It bypasses mTLS, runs single-tenant, holds credentials in process memory (loaded once from disk at boot), and **does not accept `POST /sessions`** — sessions are minted by `POST /demo/sessions` from the boot-time config instead (calls to the mTLS `POST /sessions` or `DELETE /sessions/:id` return 404). The bundled UI displays a **"Demo session — not authenticated"** banner so anyone using it can see at a glance that they are not in production. The production path (mTLS + `POST /sessions` from your backend) is unchanged when you graduate; the same binary serves both modes — and exercises the same iframe handshake every day in dev.

augchatd serves `GET /healthz` on the same origin in both modes, returning `{ "mode": "demo" | "prod", "status": "ok" }`. The `mode` field is the safety net for accidental demo deploys — fail your deploy if a production health check reports `"mode": "demo"`.

### Production-ish boot (Docker Compose, self-signed mTLS)

For a prod-mode boot on your machine — nginx terminating TLS in front of augchatd, mTLS on `:8443`, browser TLS on `:443`:

```bash
# 1. Generate the self-signed CA + server + client bundle into docker/certs/.
#    Idempotent; re-running with the same domain is a no-op.
docker compose run --rm cert-init augchatd.local

# 2. Per-deploy secrets.
echo "AUGCHATD_JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "AUGCHATD_DOMAIN=augchatd.local"             >> .env

# 3. Boot. augchatd has no published ports — only nginx is reachable.
docker compose up --build
```

The proxy refuses to start if `docker/certs/server.crt|server.key|clients-ca.crt` is missing; augchatd refuses to start until the proxy is healthy. See [ADR-0014](spec/src/architecture/adrs/0014-docker-compose-prod-deployment.md) for the wiring rationale and [ADR-0012](spec/src/architecture/adrs/0012-out-of-process-tls.md) for why TLS lives outside augchatd. The compose stack is prod-only; demo via Docker continues to use the `docker run` snippet above.

### Deploying to a VPS (Ubuntu/Debian)

Assuming the repo is already on the VPS (`git clone` or `scp`), one script does the rest:

```bash
sudo ./scripts/deploy.sh <domain>
```

It installs Docker + Compose, enables it on boot, configures UFW (22, 80, 443, 8443), generates `.env` (preserving `AUGCHATD_JWT_SECRET` across reruns so live JWTs survive a re-deploy), seeds self-signed certs via the `cert-init` service, and boots the stack. Idempotent — safe to re-run after a partial failure or to update the domain.

## How it works

```
                            ┌──────────────────────────┐
                            │       Your software      │
                            │  (users, auth, policy)   │
                            └─────────────┬────────────┘
                                          │
                       1. setup session (mTLS, server-to-server)
                          { user_id, system_prompt, model+key,
                            connectors[]? (mcp, rag, …),
                            s3_bucket+creds }   (? = optional)
                                          │
                                          ▼
                            ┌──────────────────────────┐
                            │         augchatd         │
                            └─────────────┬────────────┘
                                          │
                       2. returns { session_id, jwt }
                                          │
                                          ▼
   ┌──────────────────────────┐    3. chat (JWT)    ┌──────────────────────────┐
   │  augchatd bundled UI     │ ──────────────────► │  augchatd backend        │
   │  (assistant-ui, iframed  │ ◄── streamed reply ─│  (tool-use loop server)  │
   │   in your software)      │                     │                          │
   └──────────────────────────┘                     └──────────────────────────┘
       (UI and backend run in the same augchatd process, same origin)
                                                                │
                                                                ▼
                                                    ┌─────────────────────┐
                                                    │  LLM │ MCP │ RAG    │
                                                    │  (server-side only) │
                                                    └─────────────────────┘
```

**Two calls do everything:**

1. **Your backend → augchatd** (mTLS): "Create a session for `user_42` with this LLM and key, this S3 bucket for cold storage, this system prompt, and — if the user is allowed — these MCP servers and this RAG backend." augchatd returns a short-lived JWT.
2. **Embedded UI → augchatd** (JWT): chat. augchatd loops between the LLM and the conversation's active connectors (MCP, RAG, …) server-side. The UI (assistant-ui, bundled with augchatd, embedded in your app via iframe) only sees the streamed reply and sanitized tool indicators.

### Token & credential refresh

- JWT validation is signature-only — no DB lookup per message, so streaming doesn't pay validation cost per token.
- If a JWT expires mid-conversation, the next message returns 401; the embedded UI requests a new JWT from your backend and resumes — the conversation state survives in storage (hot DB and your S3), not in the token.
- **The same flow handles MCP credential expiry**: if an upstream MCP returns 401 (e.g. the user's OAuth token expired), augchatd surfaces it as a 401 to the UI, which triggers the same refresh path. Your backend re-mints the session with currently-valid credentials from your token vault; augchatd holds no refresh logic of its own. One mechanism for both kinds of expiry, your backend remains the single source of truth.
- **Forced logout**: your backend can call `DELETE /sessions/:id` (mTLS) at any time to invalidate a live session. augchatd flushes any unflushed conversation state to cold first, then drops the in-memory session — subsequent chat requests bearing that JWT return 401, same as expiry.

### Storage

- **Hot**: internal SQLite database managed by augchatd (using Bun's embedded SQLite — no external DB to operate). One database per `(tenant, user)`, laid out as `data/<tenantId>/<userId>.sqlite`. The file is created on the first session for that user and lives while **any** session for that user is alive; it is removed only after all of the user's sessions have ended and conversations have flushed. The per-user partition avoids write contention between concurrent end users of the same tenant.
- **Cold**: your S3-compatible bucket, passed in per session in the setup payload.
- **Flush triggers**: session disconnect, or 5 minutes of inactivity. On resume (a new session loading an existing conversation), history is hydrated from S3 if no longer hot.
- **Durability**: augchatd tests S3 at session creation (setup fails if it can't write). Flush failures retry with exponential backoff; if no flush succeeds within ~15 minutes the affected session enters **read-only mode** — `POST /chat` returns `503` with `X-Augchatd-Reason: flush-stalled`, while `GET /conversations*` keeps working. The session auto-recovers on the first successful flush. Hot data is never dropped until cold has it.

## Stop / Start

**Stop:**
- Putting LLM keys in your frontend bundle
- Reimplementing user management inside your AI service
- Coupling AI iteration to your main app's release cycle
- Letting the browser talk to MCP servers directly

**Start:**
- Treating chat as a service your existing app provisions per session
- Keeping every credential server-side, where it already lives
- Shipping a chat PoC the same afternoon, via iframe, with no framework migration

## What augchatd does

- **Provisions per-user credentials and scope from your existing auth, at session creation.** Each session carries its own LLM key plus a list of **connectors** (typed providers — `mcp`, `rag`, …) with the end user's specific credentials and scope. augchatd **enforces** the resolved scope server-side for every message and tool call — it does not decide it (the integrator's application owns policy). Credentials live in memory for the session's lifetime — never persisted in plaintext logs, never sent to clients.
- Runs the **tool-use loop** server-side, combining the **conversation's active connectors** (MCP tools, RAG retrieval, …) with the LLM response — using only the connectors active **for the current conversation** and only their provisioned credentials. Per-conversation active state is persisted alongside the conversation, so end-user preferences survive across re-mints.
- Runs **retrieval** against the conversation's active RAG-type connectors, when present: hybrid (BM25 + kNN) against OpenSearch (pgvector is a future option). Each query is scoped to that connector's `indexes[]`.
- **Tier-stores conversation history**: hot in internal SQLite databases managed by augchatd (one DB per `(tenant, user)`, ephemeral), cold in your S3-compatible bucket (passed in per session). See [Storage](#storage) above for lifecycle and durability semantics.
- Ships a **bundled chat UI** (built on [assistant-ui](https://github.com/assistant-ui/assistant-ui)) served on the same origin as the API. You embed it as an `<iframe>` — no separate UI to host, no asset pipeline on your side.
- Exposes a **minimal browser API** (consumed by the bundled UI): list/create/delete conversations, send messages, list a conversation's connectors with active state, toggle connectors per conversation. Streaming follows the assistant-ui native protocol (Vercel AI SDK data stream).
- **Isolates tenants** logically within a single process: mTLS at setup, JWT at chat time, per-session credentials in memory, per-(tenant, user) hot storage on disk. For mutually hostile tenants — or for any tenant whose load exceeds what one process can comfortably serve — deploy one augchatd process per tenant. Horizontal scaling within a single tenant requires sticky-by-`session_id` routing across processes; stateless load-balancing is not supported today (the session registry lives in process memory).

## What augchatd does NOT do

- It does **not manage users**. Your software does, and tells augchatd who's connecting per session.
- It does **not decide** policy. Your software decides which connectors a session may have (which MCP servers, which RAG indexes, which tools) and passes that as setup config. augchatd **enforces** the resolved active scope on every message — but enforcement is not decision; the integrator is always the policy authority.
- It does **not** let the end user **add** connectors mid-conversation. The connector list is fixed at session creation; the user can only narrow it via the toggle. Adding requires a new session.
- It does **not host MCP servers**. It's a *client* to MCP servers you operate.
- It does **not connect to MCP servers over stdio**. HTTP/SSE only — stdio assumes the MCP runs co-located with the client, which doesn't fit a remote multi-tenant daemon whose per-session contract is URL + auth. Most public MCPs today are stdio-only; to use them with augchatd, wrap them in a small HTTP/SSE bridge (e.g. `mcpo`) — the bridge converts the local-only stdio model into the network contract augchatd needs.
- It does **not ingest, chunk, or embed documents**. When a RAG-type connector is present, augchatd only queries the backend (currently OpenSearch; pgvector is a future option) the connector provides. Populate it with any pipeline you like; for OpenSearch we recommend [DigitalOcean Gradient AI Knowledge Bases](https://www.digitalocean.com/products/gradient), which crawls Spaces, S3, Dropbox, or URLs and writes to OpenSearch for you.
- It does **not store credentials at rest** beyond the lifetime of an active session.
- It does **not encrypt conversation history client-side** before writing to S3. Configure server-side encryption (SSE-S3, SSE-KMS, or equivalent) on the bucket you provide. Client-side encryption is out of scope.
- It does **not implement long-term memory or planning agents**. It's a tool-use loop, not an autonomous agent framework.
- It does **not bill or meter LLM usage**. Your customer's LLM key is charged directly by the provider.
- It does **not enforce per-tenant rate limits**. If you need throttling, do it at your edge before minting the session.
- It does **not ship observability dashboards or metrics out of the box**. Logs go to stderr; wire your own collector.
- It does **not provide content moderation or PII redaction**. If you need either, run them at your edge or as an MCP tool.

## UI integration

augchatd bundles a chat UI (built on [assistant-ui](https://github.com/assistant-ui/assistant-ui)) and serves it on the same origin as its API. The daemon is a single binary that serves both — there is no separate UI to host, deploy, or version.

The flow:

1. Your backend calls `POST /sessions` on your augchatd to mint a short-lived JWT.
2. Your application loads `https://augchatd.your-infra/` in an `<iframe>`.
3. Your application passes the JWT to the iframe via `postMessage` once it signals readiness.
4. The iframe talks to augchatd on its own origin and streams the conversation.

The bundled UI is the supported frontend. The browser-facing JWT API is the contract between the bundled UI and the backend — not a public surface for custom clients.

## Why these constraints

augchatd is opinionated about staying small. Your software already knows which OAuth tokens belong to which user, and which RAG indexes a given session is allowed to touch — and rebuilding that knowledge inside a chat backend (token vault, per-request MCP router, query scoper, OAuth refresh, audit) is weeks of work that's easy to get wrong in a way that leaks across tenants. augchatd takes that decision as input at session setup and enforces it server-side, for every message. The browser never holds any of it; the chat backend never needs to know your user model.

## Status

Early. OSS, currently maintained by a single author. The API and storage layout may change before `1.0`. The `augchatd/augchatd` Docker image referenced in Quickstart is **planned but not yet published**.

Built with Bun, Hono, and TypeScript on the backend; the bundled UI is a React SPA built with Vite, embedding [assistant-ui](https://github.com/assistant-ui/assistant-ui), compiled into the binary as static assets. LLM access goes through the Vercel AI SDK (provider-agnostic: Anthropic, OpenAI, and others). Hot conversation storage uses Bun's embedded SQLite, one database per `(tenant, user)` — no external DB or cache required for the daemon to run. Tools and retrieval are delivered through a unified connector model (see ADR-0010 in `spec/src/architecture/adrs/`). When a RAG-type connector is present, retrieval runs against OpenSearch (hybrid BM25 + kNN, native); pgvector is a future option.

## License

MIT.
