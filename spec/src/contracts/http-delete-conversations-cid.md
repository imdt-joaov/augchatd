---
id: technical-contract-http-delete-conversations-cid
type: technical-contract
status: current
evidence:
  - source: src/routes/conversations.ts@3e50c1c
    section: "deleteConversationHandler"
  - source: src/conversation-registry.ts@3e50c1c
    section: "deleteConversation — cascade DELETE in a single transaction"
  - id: code-ptr-ui-conversation-delete
    source: spec/src/evidence/code-pointers/ui-conversation-delete.md
    section: "Bundled SPA RemoteThreadListAdapter.delete (Delete item in ThreadListItemMore menu)"
links:
  - relation: supports
    target: contract-storage-hot
---

# Technical contract — `DELETE /conversations/:conversation_id`

## Auth

JWT (Bearer). Enforced by `requireSession`.

## Request

`DELETE /conversations/<conversation_id>`

No body.

## Response — success

`204 No Content`

The conversation row, every message in it, and every `connector_state` row keyed to it are deleted in **one SQLite transaction**. The cascade is server-side; the caller does not need to follow up with per-table deletes.

After a successful 204:

- `GET /conversations` no longer lists the cid.
- `GET /conversations/:cid/messages` returns `404 conversation_not_found`.
- `PUT /conversations/:cid/connectors/:did` and `PUT /conversations/:cid/model` return `404 conversation_not_found`.
- A `POST /chat` with `{id: <deleted cid>}` will re-create the row via the chat-handler auto-create rule (capture-on-first-observation snapshots default_active for each in-scope connector). The new row is fresh — none of the deleted history is recovered.

## Failure modes

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{"error":"missing_conversation_id"}` | Path segment empty. |
| `401` | `{"error":"missing_jwt"\|"invalid_jwt"\|"session_gone"}` | Auth middleware rejected. |
| `404` | `{"error":"conversation_not_found"}` | The cid is not present in this user's hot SQLite — either it never existed, was previously deleted, or belongs to a different `(tenant, user)`. Idempotent: a second DELETE on the same cid returns 404. |
| `503` | `{"error":"hot_write_failed","detail":"…"}` + `X-Augchatd-Reason: hot-write-failed` | The transaction failed (disk full, FS error). No partial state: the conversation either exists fully or is fully gone. |

## Concurrency

A `POST /chat` in flight against the same cid at the moment of DELETE is **not** aborted — the chat handler holds an open SQLite connection that already resolved its `getConversation` lookup. The chat may try to `upsertMessages` on a row that no longer exists; that operation fails fast and surfaces as a `503 hot_write_failed` (per [contract-storage-hot](../behavior/contracts/storage-hot.md)).

This is acceptable: DELETE during chat is an unusual race (the bundled UI does not expose both controls simultaneously), and the audit trail (the partial assistant message will not land in storage, so the conversation is empty post-DELETE) matches user intent ("I deleted it").

## Cold-storage interaction

DELETE removes only the **hot** copy. If a cold flush has already happened (see [contract-storage-flush](../behavior/contracts/storage-flush.md)), the cold copy is not touched — augchatd does not own the integrator's S3 bucket. Integrators wanting cold-side deletion run their own retention against the bucket.

(Today flush is unimplemented — see the PENDING block on `storage-flush.md` — so the hot-only delete IS the full delete.)

## Related

- Hot storage: [contract-storage-hot](../behavior/contracts/storage-hot.md)
- Sibling: [http-get-conversations](http-get-conversations.md), [http-post-conversations](http-post-conversations.md)
