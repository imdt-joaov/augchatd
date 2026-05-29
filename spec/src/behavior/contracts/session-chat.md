---
id: contract-session-chat
type: behavior-contract
status: proposed
capability: cap-chat
evidence:
  - source: README.md@e562b2b
    section: "How it works (step 2) / What augchatd does (tool-use loop, bundled UI)"
links:
  - relation: satisfies
    target: req-001-per-user-credentials
  - relation: satisfies
    target: req-002-rag-scoping
  - relation: depends_on
    target: contract-session-create
  - relation: depends_on
    target: technical-contract-browser-streaming
  - relation: enables
    target: contract-mcp-invocation
  - relation: enables
    target: contract-rag-query
---

# Contract — Chat (tool-use loop)

## Promise

Given a valid JWT, a target `conversation_id`, and an end-user message, augchatd runs a server-side **tool-use loop**:

1. **Snapshot** the **conversation's active connector set** at the start of the turn — read from the conversation's saved per-connector active flags, reconciled against the session's resolved scope (see [adr-0010](../../architecture/adrs/0010-unified-connector-model.md) and [contract-connector-toggle](connector-toggle.md)). The snapshot is captured **once per `POST /chat` call** and held for the **entire** tool-use loop of that request — including across multiple LLM round-trips for tool calls within the same request. Toggles arriving after the snapshot is taken do not affect the in-flight turn.
2. **Fold user-message quote metadata** into the model input. When the bundled UI's selection-toolbar `Quote` button is used, the resulting user message carries `metadata.custom.quote = { text, messageId }` (see [contract-ui-rendering](ui-rendering.md) §User messages). Before invoking `convertToModelMessages`, augchatd prepends a markdown blockquote of `quote.text` as a leading `text` part on each affected user message so the LLM sees the quoted excerpt. The transform is idempotent and only mutates the model-input copy — the persisted user message keeps its original `parts` + `metadata.custom.quote`, so the UI re-renders the quote chip from metadata on reload.
3. Send conversation context + message to the LLM, exposing only the tools backed by **active connectors for this conversation**.
4. If the LLM emits tool calls, augchatd dispatches each to the responsible connector server-side:
   - **MCP-type connectors** with that connector's credentials (see [mcp-invocation](mcp-invocation.md))
   - **RAG-type connectors** scoped to that connector's allowed `indexes[]` (see [rag-query](rag-query.md))
5. Feed tool results back to the LLM.
6. Loop until the LLM produces a final assistant message OR a per-request **step cap** is hit (currently 100 steps). If the cap is hit before a final message is produced, augchatd emits a visible warning text part into the stream (so the user sees "hit the tool-use depth limit ... data is partial" instead of a silently-truncated conversation).
7. **Stream** the reply to the browser using the assistant-ui native protocol (Vercel AI SDK data stream). Each assistant message in the stream carries `metadata.augchatd = { model_id, provider }` — the model and provider that produced that turn. The bundled UI renders this as a small per-message chip so a user who switched models mid-conversation can tell which model produced each reply.

Throughout, only the session's provisioned credentials and the **conversation's active scope captured at turn start** are used. Inactive connectors are not exposed to the LLM; toggling a connector mid-turn does **not** abort an in-flight tool call.

**Toggle audit.** A `PUT /conversations/:cid/connectors/:descriptive_id` that arrives **during** an in-flight `POST /chat` for the same `:cid` is persisted immediately (per [contract-connector-toggle](connector-toggle.md)) but observed only by the **next** turn. The chat handler tracks in-flight cids (`src/chat-inflight.ts`); the PUT handler, when its write coincides with an in-flight turn, emits a `connector.toggle.deferred` event to the per-conversation JSONL trace (see [constraint-observability](../../constraints/observability.md)). Operators grepping the trace by cid can therefore answer "the toggle didn't seem to take effect" in one shot — the deferred event lands between the active turn's `request` and `response.finish`.

## Observable outcomes

- A streamed reply reaches the browser with no LLM key, connector credentials, or upstream URLs exposed.
- A streamed reply survives multi-tens-of-seconds silent gaps between SSE frames — reasoning models routinely produce these between tool-call rounds. See [adr-0011](../../architecture/adrs/0011-tolerate-reasoning-model-stream-gaps.md).
- When the active model is a reasoning model (OpenAI `o[1-9]*` / `gpt-5*`; Anthropic `claude *opus* | *sonnet*`), the stream includes `reasoning-*` UI parts carrying the provider's reasoning summary. The bundled UI renders them as a collapsible "Reasoning" section beneath the assistant message. Non-reasoning models do not emit these parts. The conversation can opt out of reasoning surfacing via [contract-reasoning-toggle](reasoning-toggle.md) — when off, augchatd omits the provider option that requests the summary (OpenAI o-series / gpt-5) or extended thinking (Anthropic Opus / Sonnet) and the stream contains no `reasoning-*` parts.
- Tool-call indicators in the stream are sanitized — they show *what was called* (the connector's `descriptive_id` / display name) but not credentials or internal URLs.
- A second concurrent session calling the same MCP URL carries **that session's connector credentials**, not the first's.
- A connector toggled off for conversation `:cid` via `PUT /conversations/:cid/connectors/:descriptive_id { active: false }` is **not present** in the tool list of the next chat turn against that conversation — but it remains exposed for chat turns against other conversations where it is still active.
- When the session is in **read-only mode** because its cold-storage flush has stalled past threshold (see [storage-flush](storage-flush.md) / [storage-durability](../../constraints/storage-durability.md)), `POST /chat` returns `503 Service Unavailable` with `X-Augchatd-Reason: flush-stalled` — `GET /conversations*` continues to serve reads. **The bundled UI surfaces this state with a visible "Service temporarily read-only — your messages are preserved" banner and disables the chat input** until recovery. The session auto-recovers on the next successful flush; the banner disappears automatically.
- **Client-side abort.** When the browser closes the connection mid-turn (tab close, navigation, explicit "stop" button), augchatd propagates the disconnect's `AbortSignal` to the upstream provider call and to every in-flight MCP / RAG tool call — the LLM stops generating, the connector requests stop in flight, no further tokens are billed. The partial assistant message assembled up to that point IS persisted to hot storage (the trace logs an `aborted` event instead of `response.finish`); replay of the conversation in a later session sees the partial as the assistant's response so the next turn's context reflects what the user actually saw.

## Non-promises

- augchatd does not implement planning, long-term memory, or autonomous agent loops.
- augchatd does not retry an LLM provider failure beyond what the Vercel AI SDK does.
- augchatd does not moderate or PII-redact messages.

## Tests this contract implies

- A simple chat round-trips with no tools provisioned.
- A chat with an MCP tool fires the MCP with the session's credentials and returns the result.
- A chat with RAG fires a query restricted to the allowed indexes.
- Two concurrent sessions hitting the same MCP carry distinct credentials in the captured outbound request.
- Streamed reply is consumable by an assistant-ui client without modification.
