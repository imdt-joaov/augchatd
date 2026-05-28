---
id: technical-contract-http-post-sessions
type: technical-contract
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "README header (curl example) / How it works (step 1)"
  - source: README.md
    section: "README header (ttl_seconds note)"
  - source: src/routes/sessions.ts
    section: "createSessionHandler"
  - source: src/server.ts
    section: "POST /sessions mount (prod && trusted_proxy)"
links:
  - relation: supports
    target: contract-session-create
  - relation: depends_on
    target: adr-0012-out-of-process-tls
---

# Technical contract — `POST /sessions`

## Auth

**mTLS.** Client certificate is required and identifies the mTLS tenant — used to partition **hot** storage. Cold storage is specified per session via `storage.s3` and is not partitioned by the mTLS tenant.

TLS is terminated **out-of-process** by a reverse proxy (see [adr-0012-out-of-process-tls](../architecture/adrs/0012-out-of-process-tls.md)). The proxy forwards `X-Client-Cert-Verify` + `X-Client-Cert-Subject` to augchatd; the cert's `O` (Organization) attribute becomes the `tenantId`. The route is only mounted when the operator sets `TRUSTED_PROXY=true` — without it, the route 404s (preventing a forgotten-proxy deploy from accepting unauthenticated session-create requests).

The body's `user_id` is required and authoritative — the integrator's backend tells augchatd which of THEIR users this session is for. The cert's `CN` is parsed for sanity (the middleware rejects malformed/empty CNs) but is not the source of truth.

## Request

`POST /sessions`
`Content-Type: application/json`

### Body (from README example)

```json
{
  "user_id":     "user_42",
  "ttl_seconds": 60,
  "system_prompt": "You are a helpful assistant.",
  "model": {
    "provider": "anthropic",
    "model_id": "claude-opus-4-7",
    "api_key": "sk-ant-..."
  },
  "connectors": [
    {
      "descriptive_id": "rag_public",
      "name":           "Base de conhecimentos pública",
      "type":           "rag",
      "default_active": true,
      "backend":        "opensearch",
      "cluster":        "https://your-opensearch/",
      "auth":           { "bearer": "..." },
      "indexes":        ["public-docs"]
    },
    {
      "descriptive_id": "mcp_github",
      "name":           "GitHub (user OAuth)",
      "type":           "mcp",
      "default_active": true,
      "url":            "https://your-mcp/",
      "auth":           { "bearer": "ghu_..." }
    }
  ],
  "storage": {
    "s3": {
      "endpoint":          "https://s3.us-east-1.amazonaws.com",
      "region":            "us-east-1",
      "bucket":            "your-bucket",
      "prefix":            "ai-chat-storage/",
      "access_key_id":     "AKIA...",
      "secret_access_key": "..."
    }
  }
}
```

### Required fields

- `user_id`
- `system_prompt`
- `model` (`provider`, `model_id`, `api_key`)
- `storage.s3` (`endpoint`, `region`, `bucket`, `access_key_id`, `secret_access_key`; `prefix` optional, defaults to `""`)

### `storage.s3` sub-fields

| Field | Type | Notes |
| --- | --- | --- |
| `endpoint` | string | Full HTTPS URL of the S3-compatible API. Required so non-AWS providers (DigitalOcean Spaces, MinIO, Backblaze B2, Cloudflare R2, …) work — there is no global "S3 endpoint" to derive from region alone. For AWS itself, use the regional endpoint like `https://s3.us-east-1.amazonaws.com`. |
| `region` | string | Bucket's region, e.g. `"us-east-1"`, `"fra1"` for DO Spaces. Some SDKs require it even when the endpoint is explicit; passed through to the S3 client. |
| `bucket` | string | Bucket name. Not partitioned by mTLS tenant — the bucket itself is the cold partition (see [domain/concepts](../domain/concepts.md)). |
| `prefix` | string (optional, default `""`) | Object-key prefix prepended to every flushed conversation, e.g. `"ai-chat-storage/"`. Useful for sharing a bucket between augchatd and other workloads. |
| `access_key_id` | string | S3 access-key id. Held in the in-memory session registry; never logged. |
| `secret_access_key` | string | S3 secret. Same. |

Why an object and not a single URI string: S3-compatible providers split endpoint from credentials (most secret-managers refuse to embed credentials in URLs), and the `endpoint` cannot be derived from a bucket name on non-AWS providers. The demo template at `local/demo_session.json.example` ships the same shape so the demo config is a literal preview of this body.

### Optional fields

- `ttl_seconds` — JWT lifetime in seconds. **Default `60`**, deliberately low so development exercises the refresh path frequently. Production typically uses ~`1800` (30 min) to amortize refresh latency. The returned `expires_at` reflects the chosen TTL.
- `connectors[]` — list of tools/retrieval providers attached to this session. Each entry carries the common fields (`descriptive_id`, `name`, `type`, `default_active`) plus type-specific fields. See the per-type shapes below. Independently optional — an empty/absent `connectors[]` is a session with no tools or retrieval. See [adr-0010-unified-connector-model](../architecture/adrs/0010-unified-connector-model.md).

### Connector entry — common fields (always required)

| Field | Type | Notes |
| --- | --- | --- |
| `descriptive_id` | string | Unique within the session. Used by the browser to address the connector (e.g. for toggling) and by augchatd in tool-call indicators. Examples: `"rag_public"`, `"mcp_acme_user_session"`. **Treat this as a stable semantic identity across sessions** — active-state persistence keys solely on `descriptive_id`, so reusing it for a different upstream silently inherits the user's saved flag (see [adr-0010, "Stability of descriptive_id"](../architecture/adrs/0010-unified-connector-model.md#stability-of-descriptive_id)). |
| `name` | string | Human-friendly display label shown by the bundled UI. |
| `type` | enum | `"mcp"` \| `"rag"`. Determines the per-type fields required. |
| `default_active` | boolean | Initial active state for the connector. Captured into the conversation's saved state at first observation; later changes to `default_active` do **not** retroactively affect conversations that have already snapshotted it (see [adr-0010](../architecture/adrs/0010-unified-connector-model.md#persistence-of-active-state-per-conversation)). |
| `description` | string (optional) | Free-form hint about what content/data lives behind this connector. RAG: prepended to the retrieve tool description. MCP: prepended to every tool description as a connector-level hint. Helps the LLM pick between connectors and shape queries without blind guessing. |

### Connector entry — `type: "mcp"`

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string | HTTP/SSE endpoint. Stdio MCPs require a bridge (see [adr-0004](../architecture/adrs/0004-http-sse-mcp-only.md)). |
| `auth` | object | Per-call auth. Three accepted shapes that compose freely (later shapes win on header collision): `{ "bearer": "..." }` → `Authorization: Bearer ...`; `{ "basic": { "username": "...", "password": "..." } }` → `Authorization: Basic <base64(user:pass)>`; `{ "headers": { "X-Mcp-Client-Id": "...", ... } }` → arbitrary headers forwarded as-is (for vendor-specific signing schemes, client-id/secret pairs, etc.). |
| `read_only` | boolean (optional, default `true`) | Safety gate. When `true`, augchatd only exposes tools the MCP server has annotated `readOnlyHint: true` — unannotated tools and tools with `destructiveHint: true` are filtered out. Set to `false` to opt the connector in to writes (explicit integrator decision). |

### Connector entry — `type: "rag"`

| Field | Type | Notes |
| --- | --- | --- |
| `backend` | enum | Currently `"opensearch"`. `"pgvector"` is a future option, **not accepted today** — see [pressure-pgvector-backend](../pressure/pgvector-backend.md). A payload with any other value is rejected at session creation. |
| `cluster` | string | Backend URL. |
| `auth` | object | Backend credentials. For OpenSearch the typical shape is `{ "bearer": "..." }` for a managed service or `{ "basic": { "username": "...", "password": "..." } }` for self-hosted clusters; augchatd passes the object through to the OpenSearch client. |
| `indexes` | string[] | OpenSearch indexes this connector is scoped to. |
| `language` | string (optional) | Natural-language hint about the corpus, e.g. `"fr"`, `"French"`, `"pt-BR + en"`. Surfaced in the retrieve tool's description so the LLM phrases queries in the right language. BM25 is lexical — a PT query against an FR corpus won't match without this hint. |

### Validation rules

- Each `descriptive_id` is unique within the session.
- Each connector's `type` matches a known enum value; per-type required fields are all present.
- For `type: "rag"`, `backend` is `"opensearch"` (other values rejected for now).

## Response — success

`200 OK`
`Content-Type: application/json`

```json
{
  "session_id": "...",
  "jwt": "eyJ...",
  "expires_at": "..."
}
```

## Response — failure modes

- `4xx` on missing required fields.
- `4xx` on S3 write-test failure (no session is created).
- `401`/`403` on mTLS failure.

## Related

- Behavior: [session-create](../behavior/contracts/session-create.md)
- Auth: [security constraint](../constraints/security.md)
