---
id: code-ptr-ui-conversation-list
type: evidence
status: current
source_kind: code
ref: "ui/src/lib/threadListAdapter.tsx:createThreadListAdapter.list@WIP"
proves: technical-contract-http-get-conversations
---

> [!NOTE] Pending commit
> The `@WIP` marker is a placeholder until the assistant-ui ThreadList
> refactor lands. Bump to the merge commit when the branch
> `improvements` is squashed onto `main`.

The bundled SPA consumes `GET /conversations` from a `RemoteThreadListAdapter`
implementation: `createThreadListAdapter().list()` in
`ui/src/lib/threadListAdapter.tsx`. assistant-ui's
`useRemoteThreadListRuntime` invokes it on mount (and on `aui.threads().reload()`),
expects `{ conversations: [...] }`, and maps each row to a
`RemoteThreadMetadata` `{ remoteId: conversation_id, status: "regular", title }`.
Rendering is delegated to the shadcn-registry component
`ui/src/components/assistant-ui/thread-list.tsx`, which uses the
`ThreadListPrimitive.Items` iterator and per-row `ThreadListItemPrimitive.Title`
(with a "New Chat" fallback when `title` is `null`). `updated_at` is no longer
read directly — assistant-ui orders threads by load order. The contract's
`title: string | null` shape is still load-bearing.
