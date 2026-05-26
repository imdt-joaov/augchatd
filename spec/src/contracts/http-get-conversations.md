---
id: technical-contract-http-get-conversations
type: technical-contract
status: current
evidence:
  - source: src/routes/conversations.ts@3e50c1c
    section: "listConversationsHandler"
  - source: src/conversation-registry.ts@3e50c1c
    section: "listConversations — SQL with first_user_parts subselect + deriveTitle"
  - id: code-ptr-ui-conversation-list
    source: spec/src/evidence/code-pointers/ui-conversation-list.md
    section: "Bundled SPA sidebar consumer (fetch + render)"
links:
  - relation: supports
    target: contract-storage-hot
---

# Technical contract — `GET /conversations`

## Auth

JWT (Bearer). Enforced by `requireSession`.

## Request

`GET /conversations`

No body. No query parameters today (returns the full list).

## Response — success

`200 OK`
`Content-Type: application/json`

```json
{
  "conversations": [
    {
      "conversation_id": "...",
      "title": "Quantos workflows existem?…",
      "message_count": 6,
      "model_id_override": "gpt-4o-mini",
      "updated_at": "2026-05-25T13:32:14.336Z"
    },
    ...
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `conversation_id` | string | Stable across reads. |
| `title` | string \| null | Auto-derived from the first user message's first `{type:"text"}` part; trimmed, truncated to 60 chars with a `…` ellipsis. `null` if no user message has been sent yet (a freshly-minted conversation with no chat turn). The integrator may compute its own title later — augchatd does not currently expose a `PATCH /conversations/:cid` to override. |
| `message_count` | integer ≥ 0 | Total stored messages (user + assistant). |
| `model_id_override` | string \| null | The model the conversation picked via `PUT /conversations/:cid/model`, or `null` if the session default is still in effect. |
| `updated_at` | string (ISO 8601) | `max(message.updated_at)` across the conversation's messages; falls back to the conversation row's `created_at` if no message has been written yet. |

**Order:** most-recent-first by `updated_at`.

## Empty response

A session with no conversations returns `200 { "conversations": [] }`.

## Failure modes

| Status | Body | Cause |
| --- | --- | --- |
| `401` | `{"error":"missing_jwt"\|"invalid_jwt"\|"session_gone"}` | Auth middleware rejected. |

No `503 hot_write_failed` — this endpoint is read-only.

## Scope

The endpoint scopes to the session's `(tenant, user)` partition (see [contract-storage-hot](../behavior/contracts/storage-hot.md) §"Conversations are scoped to `(tenant, user)`"). A second session for the same user sees the same list — that is the resume-after-disconnect path. Different `user_id`s under the same `tenant_id` get disjoint lists.

## Related

- Hot storage: [contract-storage-hot](../behavior/contracts/storage-hot.md)
- Sibling: [http-post-conversations](http-post-conversations.md) (mint), [http-delete-conversations-cid](http-delete-conversations-cid.md) (delete)
