---
id: technical-contract-http-post-conversations
type: technical-contract
status: current
evidence:
  - source: src/routes/conversations.ts@ca3458a
    section: "createConversationHandler — optional client id, hot-write, 201 body"
  - source: src/conversation-registry.ts@ca3458a
    section: "createConversation — single transaction: INSERT conversation + snapshotDefaultsTx"
  - id: code-ptr-ui-conversation-new
    source: spec/src/evidence/code-pointers/ui-conversation-new.md
    section: "Bundled SPA RemoteThreadListAdapter.initialize (eager on thread mount; also drives ThreadListPrimitive.New)"
links:
  - relation: supports
    target: contract-connector-toggle
  - relation: supports
    target: adr-0010-unified-connector-model
---

# Technical contract — `POST /conversations`

## Auth

JWT (Bearer). Enforced by `requireSession`.

## Request

`POST /conversations`
`Content-Type: application/json` (or omitted entirely; see below)

### Body

The body is **optional**. Two accepted shapes:

| Shape | Behavior |
| --- | --- |
| Empty body / no `Content-Type: application/json` | Server mints a fresh UUID `conversation_id`. |
| `{ "conversation_id": "<non-empty-string>" }` | Server adopts the supplied id. Idempotent on this id — re-posting the same id returns 201 again without overwriting the existing row. |

The bundled UI uses the second shape, passing the assistant-ui-generated thread id so the client-side runtime keeps a stable reference. Both shapes capture per-connector `default_active` into the conversation's saved state in the same single transaction as the row insert (see [adr-0010](../architecture/adrs/0010-unified-connector-model.md) §"Atomicity").

## Response — success

`201 Created`
`Content-Type: application/json`

```json
{ "conversation_id": "<server-or-client-supplied-uuid>" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `conversation_id` | string | The same id sent (if `conversation_id` was in the body) or a freshly minted UUID. |

201 (not 200) reflects that a hot-storage row is created in the same call — even on the idempotent re-post path, the contract returns 201 for consistency rather than switching to 200 on the second call.

## Failure modes

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{"error":"invalid_conversation_id"}` | `conversation_id` was present but not a non-empty string. |
| `401` | `{"error":"missing_jwt"\|"invalid_jwt"\|"session_gone"}` | Auth middleware rejected the request. |
| `503` | `{"error":"hot_write_failed","detail":"…"}` + `X-Augchatd-Reason: hot-write-failed` | SQLite write failed (disk full, FS error, etc.). |

## Idempotency

Re-posting with the same `conversation_id`:

- The `INSERT INTO conversation` is guarded by a SELECT-then-INSERT inside the transaction, so the row is created once. Re-posts are no-ops at the row level.
- `snapshotDefaultsTx` runs each time, capturing any **new** connectors that entered scope since the last visit (the "sliding scope" rule from [contract-connector-toggle](../behavior/contracts/connector-toggle.md)). Existing `connector_state` rows are not overwritten.
- The 201 response is returned regardless.

## Related

- Behavior: [contract-connector-toggle](../behavior/contracts/connector-toggle.md) (capture-on-first-observation; this endpoint is one of the observation triggers)
- Hot storage: [contract-storage-hot](../behavior/contracts/storage-hot.md)
- ADR: [adr-0010-unified-connector-model](../architecture/adrs/0010-unified-connector-model.md)
