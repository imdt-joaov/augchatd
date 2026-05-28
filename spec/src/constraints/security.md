---
id: constraint-security
type: constraint
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "README header / Stop/Start / What augchatd does NOT do / Storage"
links:
  - relation: supports
    target: req-003-server-side-secrets
---

# Constraint — Security posture

Cross-cutting rules that hold across every capability.

## Secrets

- **Browser holds**: JWT (short-lived, minutes). Nothing else.
- **Process memory holds** (for the session's lifetime): LLM key, per-connector credentials (MCP auth, RAG backend auth) and upstream URLs (MCP URL, RAG cluster), S3 credentials.
- **No persistent credential storage**. Credentials are dropped when the session ends.
- **No plaintext credentials in logs.** Logs go to stderr; the operator wires their own collector.

## Transport

- **Backend → augchatd**: mTLS for `POST /sessions` and `DELETE /sessions/:id`. TLS is terminated **out-of-process** by a reverse proxy (see [adr-0012-out-of-process-tls](../architecture/adrs/0012-out-of-process-tls.md)); the proxy validates the client cert against its CA bundle and forwards `X-Client-Cert-Verify` + `X-Client-Cert-Subject` to augchatd. The client certificate identifies the mTLS tenant: by default, `O` → `tenantId`, `CN` → `userId`.
- **Browser → augchatd**: JWT (Bearer) over the same origin as the bundled UI.
- **augchatd → MCP**: HTTP or SSE, with per-session auth (typically `bearer`). No stdio.
- **augchatd → LLM**: Whatever the Vercel AI SDK uses for that provider; key is per session.
- **augchatd → S3**: HTTPS with per-session credentials.

## Storage at rest

- **Hot SQLite** is **not encrypted** by augchatd. Disk-level encryption is the operator's choice.
- **Cold S3** is **not client-side encrypted** by augchatd. Operators configure **SSE-S3 / SSE-KMS / equivalent** on the bucket.

## Out of scope (security)

- Content moderation
- PII redaction
- Audit log shipping
- Per-tenant rate limiting

These belong at the integrator's edge or as MCP tools.

## Threat-model note

augchatd assumes the integrator's backend is trusted. The trust boundary is the augchatd process. For mutually hostile tenants, see [tenant-isolation](tenant-isolation.md).
