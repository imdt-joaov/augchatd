---
id: technical-contract-http-delete-sessions
type: technical-contract
status: proposed
evidence:
  - source: README.md
    section: "Token & credential refresh — Forced logout"
  - source: src/routes/sessions.ts
    section: "deleteSessionHandler"
  - source: src/server.ts
    section: "DELETE /sessions/:session_id mount (prod && trusted_proxy)"
links:
  - relation: supports
    target: contract-session-delete
  - relation: depends_on
    target: adr-0012-out-of-process-tls
---

# Technical contract — `DELETE /sessions/:session_id`

## Auth

**mTLS.** Same trust requirement as `POST /sessions`. Only the integrator's backend may delete a session — the browser cannot reach this endpoint (no JWT scope grants delete on a session).

## Request

`DELETE /sessions/:session_id`

No body.

## Response — success

`204 No Content`

The response is returned only **after** the final flush to cold storage has completed successfully; until then the request blocks.

## Response — failure modes

- `404` if `session_id` is unknown (already deleted, never existed, or expired).
- `401` / `403` on mTLS failure.
- `5xx` if the final flush to cold cannot be confirmed within the request deadline. In that case the session is **not** released — the integrator may retry.

## Idempotency

A second `DELETE` of the same `session_id` returns `404` (the first delete already released the in-memory record). Effectively at-most-once with safe retry semantics: client retry after a `204` is `404`, not a destructive operation.

## Related

- Behavior: [session-delete](../behavior/contracts/session-delete.md)
- Auth: [security constraint](../constraints/security.md)
- Storage interplay: [storage-flush](../behavior/contracts/storage-flush.md)
