---
id: contract-reasoning-toggle
type: behavior-contract
status: proposed
capability: cap-chat
evidence: []
links:
  - relation: refines
    target: contract-session-chat
  - relation: depends_on
    target: contract-storage-hot
---

# Contract — Reasoning toggle (per conversation)

## Promise

A conversation can opt out of having the LLM's internal reasoning surfaced to the user. The toggle is **per-conversation**, persisted in hot SQLite alongside `model_id_override`, and defaults to **enabled** (existing behavior).

When **enabled** (default):

- For reasoning-capable models (OpenAI `o[1-9]*` / `gpt-5*`; Anthropic `*opus* | *sonnet*`), augchatd sets the provider option that surfaces reasoning — OpenAI `{ reasoningSummary: "auto" }`, Anthropic `{ thinking: { type: "enabled", budgetTokens: 2048 } }`.
- The chat stream emits `reasoning-*` UI parts the bundled UI renders as a collapsible "Reasoning" section.

When **disabled**:

- augchatd passes **no** reasoning-related provider option for that turn.
- The chat stream contains no `reasoning-*` parts.
- **Cost note (provider-specific):** Anthropic Opus/Sonnet no longer pay extended-thinking tokens (the API default is no thinking). OpenAI `o[1-9]` / `gpt-5` still incur `reasoning_tokens` server-side — those models always reason; disabling the toggle only suppresses the *summary stream*. The bundled UI surfaces this difference in a tooltip on the toggle so users do not mistake the toggle for a cost control on OpenAI.

For models that are not reasoning-capable, the toggle has no effect and the bundled UI **hides** the toggle entirely.

## HTTP surface

- `GET /conversations/:cid/reasoning` → `200 { enabled: boolean }`. Implicitly creates the conversation (capture-on-first-observation) if it does not yet exist, mirroring `GET /conversations/:cid/connectors`.
- `PUT /conversations/:cid/reasoning` body `{ enabled: boolean }` → `204` on success. Same `body_must_be_object` / `only_enabled_field_allowed` / `enabled_must_be_boolean` validation pattern as the connector and model PUTs. Same `503 X-Augchatd-Reason: hot-write-failed` on hot-DB write failure.

Both require a valid JWT bearer (`requireSession`), and in demo mode are mounted on the same branch as the other per-conversation endpoints.

## Capture rule

- Read at the start of each `POST /chat` turn (alongside `resolveModelId`). A `PUT` arriving mid-turn does **not** affect the in-flight turn — same rule as connector toggles (see [contract-session-chat](session-chat.md), step 1).
- The toggle state is **independent** of the model. Switching models on a conversation does **not** reset the toggle. If the user disables reasoning on a non-reasoning model and then switches to a reasoning model, the saved `disabled` state takes effect on the next turn.

## Observable outcomes

- Two sequential turns on the same `cid` with different toggle values produce streams with vs. without `reasoning-*` parts.
- `PUT /conversations/:cid/reasoning { enabled: false }` then `POST /chat` against an OpenAI gpt-5 model: the response stream has no reasoning parts; the upstream request omits `reasoningSummary`.
- `PUT /conversations/:cid/reasoning { enabled: false }` then `POST /chat` against an Anthropic Sonnet model: the response stream has no reasoning parts; the upstream request omits the `thinking` provider option.
- `GET /conversations/:cid/reasoning` on a freshly-created conversation returns `{ enabled: true }`.
- A reload of the bundled UI preserves the toggle state (hot-storage backed).

## Non-promises

- The toggle does not control how *the LLM* internally reasons — it only controls whether augchatd asks the provider to *surface* reasoning. For OpenAI o-series / gpt-5, the model continues to consume `reasoning_tokens` regardless.
- The toggle does not affect cold-storage flushed history beyond the columns that already persist.
- No analytics or audit-log entry beyond standard trace events.

## Tests this contract implies

- `GET /conversations/:cid/reasoning` on a new conversation → `200 { enabled: true }`.
- `PUT /conversations/:cid/reasoning { enabled: false }` → `204`; subsequent `GET` returns `{ enabled: false }`.
- `PUT` with `{ enabled: "no" }` → `400 enabled_must_be_boolean`.
- `PUT` with extra fields → `400 only_enabled_field_allowed`.
- After `PUT { enabled: false }`, a `POST /chat` turn on a reasoning model emits zero `reasoning-*` UI parts.
- After `PUT { enabled: false }` then `PUT { enabled: true }`, a `POST /chat` turn on a reasoning model emits reasoning parts again.
- A non-reasoning model + toggle disabled + a chat turn: behaves identically to a non-reasoning model with toggle enabled (no-op).
- `GET /session/models` includes `supports_reasoning: boolean` per model — used by the UI to hide the toggle for unsupported models.
- Hot-write failure on `PUT` → `503` with `X-Augchatd-Reason: hot-write-failed`.
