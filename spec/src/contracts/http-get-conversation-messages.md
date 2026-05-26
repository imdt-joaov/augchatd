---
id: technical-contract-http-get-conversation-messages
type: technical-contract
status: current
evidence:
  - source: src/routes/conversations.ts@ca3458a
    section: "listConversationMessagesHandler — 200 / 404 / 400"
  - source: src/conversation-registry.ts@ca3458a
    section: "listMessages — SELECT ordered by ordinal, parts_json + metadata_json parsed back"
  - id: code-ptr-ui-conversation-switch
    source: spec/src/evidence/code-pointers/ui-conversation-switch.md
    section: "Bundled SPA switchConversation action (sidebar row click hydrates the chat runtime)"
---

# Technical contract — `GET /conversations/:conversation_id/messages`

## Auth

JWT (Bearer). Enforced by `requireSession`.

## Request

`GET /conversations/<conversation_id>/messages`

No body. No query parameters today (returns the full thread).

## Response — success

`200 OK`
`Content-Type: application/json`

```json
{
  "messages": [
    {
      "message_id": "msg_…",
      "ordinal": 0,
      "role": "user",
      "parts": [...],
      "metadata": {"augchatd": {"model_id": "...", "provider": "..."}}
    },
    ...
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `message_id` | string | The id originally assigned by the client transport (assistant-ui or, in production, the integrator's chat front-end). Stable across reads. |
| `ordinal` | integer ≥ 0 | Insertion order within the conversation. Used as the primary sort key. |
| `role` | `"user"` \| `"assistant"` \| `"system"` | UIMessage role. |
| `parts` | array | The Vercel AI SDK UIMessage parts array (text, reasoning, tool-call, tool-output, source-document, etc.). Parsed from `parts_json` in SQLite. |
| `metadata` | object \| null | Assistant-side: `{augchatd: {model_id, provider}}` carrying which model produced the reply. May be `null` for older rows or messages that pre-date the metadata column migration. |

**Ordering.** `ORDER BY ordinal ASC, message_id ASC`. Aborted streams persist their partial assistant message with the same ordinal as a complete one would have (see [contract-session-chat](../behavior/contracts/session-chat.md)).

## Failure modes

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{"error":"missing_conversation_id"}` | Path segment empty after the prefix. |
| `401` | `{"error":"missing_jwt"\|"invalid_jwt"\|"session_gone"}` | Auth middleware rejected. |
| `404` | `{"error":"conversation_not_found"}` | The cid is not present in this user's hot SQLite. Cross-user implicit auth boundary: a cid that exists for a different `(tenant, user)` also returns 404 — there is no explicit cross-session check, just the storage partition. |

## Empty response

A freshly-minted conversation that has no messages yet returns `200 { "messages": [] }`. The bundled UI uses this on boot to hydrate `/c/<cid>` URLs — see [browser-streaming](browser-streaming.md) §"URL convention".

## Related

- Hot storage: [contract-storage-hot](../behavior/contracts/storage-hot.md)
- URL convention that drives this endpoint: [browser-streaming](browser-streaming.md)
- Behavior: [contract-session-chat](../behavior/contracts/session-chat.md) (the writes this endpoint reads from)
