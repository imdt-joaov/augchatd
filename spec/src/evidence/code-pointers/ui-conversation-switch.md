---
id: code-ptr-ui-conversation-switch
type: evidence
status: current
source_kind: code
ref: "ui/src/lib/threadListAdapter.tsx:createHistoryAdapter@WIP"
proves: technical-contract-http-get-conversation-messages
---

> [!NOTE] Pending commit
> The `@WIP` marker is a placeholder until the assistant-ui ThreadList
> refactor lands. Bump to the merge commit when the branch
> `improvements` is squashed onto `main`.

The bundled SPA loads a conversation's stored messages through
`GET /conversations/:cid/messages` via the per-thread
`ThreadHistoryAdapter` returned by `createHistoryAdapter(authedFetch, cidRef)`
in `ui/src/lib/threadListAdapter.tsx`. The fetch fires from
`withFormat(fmt).load()`, which assistant-ui's AI SDK runtime calls when
the active thread changes (typically after a click on
`ThreadListItemPrimitive.Trigger` in
`ui/src/components/assistant-ui/thread-list.tsx`). Server `messages[]`
are reshaped into the AI SDK `MessageStorageEntry` row
`{ id: message_id, parent_id: <previous id>, format: "ai-sdk/v6",
content: { role, parts, metadata? } }` and fed through `fmt.decode` so they
round-trip as `UIMessage`. The `parent_id` chain is synthesized linearly
(server has no parent tracking) so messages render as a single branch.
The URL is mirrored to `/c/<cid>` by the `UrlSync` effect in
`ui/src/App.tsx`, which subscribes to `s.threadListItem.remoteId`.
