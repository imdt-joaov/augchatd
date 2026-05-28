---
id: contract-session-delete
type: behavior-contract
status: proposed
capability: cap-session-mgmt
evidence:
  - source: README.md
    section: "Token & credential refresh — Forced logout"
  - source: src/routes/sessions.ts
    section: "deleteSessionHandler"
  - source: src/flush-scheduler.ts
    section: "flushAllForSession (returns false on failure → 503)"
links:
  - relation: depends_on
    target: contract-session-create
  - relation: depends_on
    target: technical-contract-http-delete-sessions
  - relation: depends_on
    target: contract-storage-flush
---

# Contract — Session delete (forced logout)

## Promise

Given a valid mTLS client cert and an existing `session_id`, augchatd:

1. **Locates** the in-memory session record.
2. **Triggers a final flush** of any unflushed hot conversation state for that session to cold (S3), under the same durability rules as a normal disconnect (see [storage-flush](storage-flush.md)).
3. **Releases** the in-memory session record. The session's JWT is no longer accepted: subsequent chat requests bearing that JWT return **401** (same path as JWT expiry — see [jwt-refresh](jwt-refresh.md)).
4. **Responds** with `204 No Content` to the deleting backend.

If the `session_id` is unknown, augchatd responds with `404` and no side effects occur.

## Observable outcomes

- A chat request bearing a deleted session's JWT returns 401 immediately after the delete completes — without waiting for `ttl_seconds` to elapse.
- The conversation that the deleted session was attached to is retrievable from cold storage with no data loss (any unflushed hot state was flushed first).
- A second concurrent session for the same user is unaffected — only the named `session_id` is released.
- A delete attempt without a valid mTLS cert is rejected before the session is touched.

## Non-promises

- augchatd does not propagate the deletion to any external system (no MCP logout, no LLM session teardown — those services do not have session concepts owned by augchatd).
- augchatd does not credit, refund, or notify the LLM provider — billing happens directly between integrator and provider.
- augchatd does not retain a "tombstone" of the deleted session for audit; the integrator's logs are the audit surface.
- augchatd does not block a re-mint of a session for the same `user_id` — a new `POST /sessions` immediately afterward is allowed.

## Tests this contract implies

- Delete a live session → subsequent chat with its JWT returns 401.
- Delete a session with unflushed hot state → cold storage receives the flush before the 204 response; subsequent read from cold finds the conversation intact.
- Delete a nonexistent `session_id` → 404, no side effects elsewhere.
- Delete one of two concurrent sessions for the same `user_id` → the other continues to work.
- Delete attempt without a valid mTLS cert → 401/403; no session touched.
