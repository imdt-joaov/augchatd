---
id: technical-contract-http-get-session-models
type: technical-contract
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "What augchatd does (minimal browser API)"
links:
  - relation: supports
    target: cap-model-selection
---

# Technical contract — `GET /session/models`

## Auth

JWT (Bearer), per [browser-streaming](browser-streaming.md).

## Request

`GET /session/models`

No body.

## Response — success

`200 OK`
`Content-Type: application/json`

```json
{
  "models": [
    { "id": "gpt-5-mini", "display_name": "gpt-5-mini", "provider": "openai", "created_at": "2025-08-07T00:00:00.000Z" },
    { "id": "gpt-4.1",    "display_name": "gpt-4.1",    "provider": "openai", "created_at": "2025-04-14T00:00:00.000Z" }
  ],
  "current_model_id": "gpt-5-mini",
  "provider": "openai",
  "cached": false
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `models` | array | The provider's chat-capable, current-generation model list, filtered server-side (drops legacy gpt-3.5/4 entries, audio, image-gen, codex, search-api, deep-research). Sorted by `created_at` descending — newest first. |
| `models[].created_at` | string | ISO 8601 UTC timestamp of upstream model publication. Normalized from OpenAI's `created` (unix seconds) and Anthropic's `created_at` (RFC 3339). The bundled UI uses this to render the 3 most-recent models in the picker and the rest under a "More models" submenu. |
| `current_model_id` | string | The session's session-default model (from `model.model_id` at session creation — what the chat turn falls back to when no per-conversation override is set). |
| `provider` | string | The session's provider (`openai`, `anthropic`, ...) — same one used for the upstream `/v1/models` call. |
| `cached` | boolean | `true` if served from the in-process cache; `false` if this call hit the provider. |

## Caching

augchatd keeps an in-process cache keyed by `(session_id, provider)` with a **10-minute TTL**. Concurrent calls in the same window return the cached list. The PUT endpoint validates against the same cache (filling it if cold) — see [http-put-conversation-model](http-put-conversation-model.md).

## Failure modes

- `401 Unauthorized` — missing / invalid / expired JWT (per [jwt-refresh](../behavior/contracts/jwt-refresh.md)).
- `502 Bad Gateway` with `{ "error": "provider_list_failed", "detail": "..." }` — upstream provider call failed (rate limit, network, invalid key surfaced here for the first time, etc.). The cache is **not** populated on failure.

## Why this exists

The end user of the bundled UI may want to pick a different model for a conversation than the one the integrator provisioned at session creation. Today the integrator owns the provider + api key (one provider per session), but the end user can choose any model that key can run. This endpoint surfaces "what's available" so the UI's model picker doesn't have to hard-code a list.

## Related

- [http-put-conversation-model](http-put-conversation-model.md) — applies the user's choice to a conversation
- [http-post-sessions](http-post-sessions.md) — the session's default model is set here
- Capability: [cap-model-selection](../behavior/capabilities.md)
