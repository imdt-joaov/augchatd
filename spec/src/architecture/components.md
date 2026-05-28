---
id: arch-components
type: adr
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "How it works / Status / What augchatd does (bundled UI)"
---

# Components

augchatd is a **single binary** that contains everything below. TLS is **not** terminated by augchatd itself — see [adr-0012-out-of-process-tls](adrs/0012-out-of-process-tls.md). A reverse proxy (the deployment's choice; we ship a sample for nginx in [`docs/deployment/nginx.conf.example`](../../../docs/deployment/nginx.conf.example)) terminates mTLS for the control-plane leg and forwards `X-Client-Cert-Verify` + `X-Client-Cert-Subject` to augchatd. The diagram below shows the augchatd process in isolation; in production it sits behind the reverse proxy.

```
augchatd process
├── HTTP API layer (Hono)
│   ├── mTLS-protected endpoints: POST /sessions, DELETE /sessions/:id
│   │     (mounted only when TRUSTED_PROXY=true; gated by requireMtlsTrust + requireIdentity)
│   ├── demo endpoints (mode=demo only):
│   │     GET  /demo, /demo/*   ← wrapper page (iframes the UI, runs the
│   │                              postMessage handshake; wildcard so
│   │                              /demo/c/<cid> resolves there too)
│   │     POST /demo/sessions   ← mint a fresh session from the
│   │                              boot-loaded local/demo_session.json
│   │                              (same shape as POST /sessions response)
│   ├── ops endpoint (both modes): GET /healthz   ← exposes "mode": "demo" | "prod"
│   ├── JWT endpoints: chat, conversation CRUD,
│   │                   GET /conversations/:cid/connectors (active per conversation),
│   │                   PUT /conversations/:cid/connectors/:descriptive_id (toggle)
│   └── static UI serving (same origin, /)
│
├── Session registry (in-memory)
│   └── { session_id → { tenant_id, user_id, system_prompt, model+key,
│                         storage, connectors[] (resolved scope), theme } }
│        each connector: { descriptive_id, name, type, default_active,
│                          description?, type-specific config }
│        — active flag lives per conversation in hot SQLite, not here
│        — JWT TTL is encoded in the JWT itself (exp), not stored here
│
├── Tool-use loop
│   ├── LLM driver (Vercel AI SDK; Anthropic, OpenAI, …)
│   └── Connector dispatcher (type-routed; only the conversation's active connectors exposed per turn)
│        ├── MCP client (HTTP/SSE, per-connector credentials)
│        └── RAG client (OpenSearch hybrid; pgvector is future)
│
├── Hot storage
│   └── Bun embedded SQLite, one DB per (mTLS tenant, user)
│        layout: data/<tenantId>/<userId>.sqlite
│        each conversation holds messages + per-connector active state
│
├── Cold storage driver
│   └── S3-compatible client (per-session bucket + creds)
│
└── Bundled UI (React + Vite static SPA, compiled into the binary)
    └── assistant-ui, served on /
```

## External dependencies

- LLM provider (per-session API key)
- Per-connector upstreams:
  - **MCP-type** connectors → MCP servers (URL + auth; HTTP/SSE)
  - **RAG-type** connectors → retrieval backend (currently OpenSearch only; pgvector is future) with per-connector credentials and `indexes[]` scope
- S3-compatible bucket (per-session credentials)

augchatd has **no required external dependencies** to start: no separate database, no separate cache, no separate frontend host. Required externals are per-session and supplied at session creation.

## Process model

- One process per deployment is the default.
- For mutually hostile tenants, deploy **one process per tenant** (see [tenant-isolation](../constraints/tenant-isolation.md)).
- Demo mode is the same binary booted with `AUGCHATD_MODE=demo`.

## Stack

Built with **Bun**, **Hono**, **TypeScript** on the backend. Bundled UI is a **React SPA built with Vite**, embedding **assistant-ui**, compiled into the binary as static assets. LLM access via **Vercel AI SDK**. Hot storage via Bun's embedded **SQLite**, one DB per (mTLS tenant, user).

See ADRs:

- [0001 — Single binary + bundled UI](adrs/0001-single-binary-bundled-ui.md)
- [0002 — Embedded SQLite per (mTLS tenant, user)](adrs/0002-embedded-sqlite-per-mtls-tenant.md)
- [0003 — Customer-provided cold storage (S3)](adrs/0003-customer-provided-cold-storage.md)
- [0004 — HTTP/SSE-only MCP transport](adrs/0004-http-sse-mcp-only.md)
- [0005 — JWT signature-only validation](adrs/0005-jwt-signature-only.md)
- [0006 — Vercel AI SDK for LLM access](adrs/0006-vercel-ai-sdk-for-llm.md)
- [0007 — Bun + Hono + TypeScript stack](adrs/0007-bun-hono-typescript.md)
- [0008 — Demo mode shares the production binary](adrs/0008-demo-mode-shares-binary.md)
- [0009 — React + Vite bundled UI](adrs/0009-react-vite-bundled-ui.md)
- [0010 — Unified connector model](adrs/0010-unified-connector-model.md)
- [0012 — TLS is terminated out-of-process](adrs/0012-out-of-process-tls.md)
