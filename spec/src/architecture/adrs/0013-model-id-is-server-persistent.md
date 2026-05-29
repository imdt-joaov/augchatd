---
id: adr-0013-model-id-is-server-persistent
type: adr
status: current
evidence:
  - source: src/routes/conversations.ts
    section: "setConversationModelHandler"
  - source: ui/src/ComposerOptionsMenu.tsx
    section: "pickModel"
links:
  - relation: supports
    target: contract-session-chat
  - relation: supports
    target: contract-ui-rendering
---

# ADR-0013 — `model_id` is per-conversation state, persisted server-side

## Context

augchatd allows the end-user to switch the LLM model mid-conversation. The UI shows a model picker in the composer; the next turn after a switch goes to the newly-selected model. The selection has to survive page reloads — opening `/c/<cid>` after F5 should put the picker on the same model the user chose before.

assistant-ui ships an official `ModelSelector` shadcn component (see [doc](https://www.assistant-ui.com/docs/ui/model-selector)) that wires through its `ModelContext` system: the component calls `aui.modelContext().register()`, and the `AssistantChatTransport` adds the selected `id` to the `/chat` request body as `config.modelName`. The backend then reads `config.modelName` to pick the provider/model.

This is the canonical assistant-ui pattern. It also conflicts with how augchatd persists state.

## Decision

The `model_id` is **per-`conversation_id` state, owned by the server and persisted in SQLite**. The UI is responsible only for surfacing the picker and writing the user's choice to the server before the next turn.

Concretely:

- **Source of truth**: the `conversations.model_id_override` column in the per-session SQLite database. The handler that mutates it is [`setConversationModelHandler` in `src/routes/conversations.ts`](../../../../src/routes/conversations.ts) (`PUT /conversations/:cid/model`, body `{ "model_id": "<id>" }`, returns `204`).
- **Read path**: `GET /conversations/:cid/model` returns the current selection (falling back to the session default).
- **UI**: [`ui/src/ComposerOptionsMenu.tsx`](../../../../ui/src/ComposerOptionsMenu.tsx) reads via `GET`, writes via `PUT`. The `/chat` body does **not** carry the model id.
- **Backend chat handler**: [`src/routes/chat.ts`](../../../../src/routes/chat.ts) calls `llmFor(session, modelId)` where `modelId` is read from the database at the start of each turn (not from the request body).

## Alternatives considered

### A. assistant-ui `ModelSelector` + `config.modelName` (the upstream-default path)

Adopt the shadcn `model-selector`, register through `aui.modelContext()`, and let `AssistantChatTransport` serialize the selection into `config.modelName` on the `/chat` body.

**Rejected.** The mode is non-durable: after a reload the client has no idea what was selected last, and the next turn defaults to whatever the runtime initialized to. To recover, the UI would need to fetch the last choice from somewhere before sending the next `/chat`, which means we'd be persisting server-side anyway *and also* shipping the choice in the body — two sources of truth.

### B. Persist client-side (localStorage / cookie)

Same durability gap as (A) once the user opens the conversation from a different browser, device, or after clearing storage. Also splits the choice across machines, which is undesirable when the integrator's backend is the actual identity boundary (the mTLS-provisioned session has one user; that user should see the same selection everywhere).

## Consequences

- We **do not adopt** `@assistant-ui/ui/model-selector` shadcn block. [`ui/src/ComposerOptionsMenu.tsx`](../../../../ui/src/ComposerOptionsMenu.tsx) remains the canonical UI for model + reasoning toggle. If the assistant-ui upstream adds a config knob to make `ModelSelector` purely presentational (without the `modelContext().register()` side effect), we can revisit.
- Any future toolbar/control surfacing must follow the same pattern: write to the conversations row, read back on next session/page load.
- The `/chat` request body stays minimal (`messages`, `trigger`, `messageId`, `id` = `conversation_id`). Auth is in the `Authorization` header. There's no per-request runtime config from the client.
