---
id: code-ptr-ui-conversation-delete
type: evidence
status: current
source_kind: code
ref: "ui/src/lib/threadListAdapter.tsx:createThreadListAdapter.delete@WIP"
proves: technical-contract-http-delete-conversations-cid
---

> [!NOTE] Pending commit
> The `@WIP` marker is a placeholder until the assistant-ui ThreadList
> refactor lands. Bump to the merge commit when the branch
> `improvements` is squashed onto `main`.

> [!IMPORTANT] PENDING RECONCILIATION
> The pre-refactor pointer claimed: "When the deleted cid matches the
> active conversation, a fresh one is minted via newConversation". After
> the refactor, the auto-recreate is owned by assistant-ui's
> `useRemoteThreadListRuntime` (we no longer wrap delete with our own
> "if active, POST a new one" branch). The replacement behavior — pick
> another thread / fall to a default local thread / mint via
> `initialize()` — has not been verified end-to-end yet. Smoke test
> needed before this pointer can claim equivalence.

The bundled SPA deletes conversations through `DELETE /conversations/:cid`
via `RemoteThreadListAdapter.delete(remoteId)` in
`ui/src/lib/threadListAdapter.tsx`. The button is
`ThreadListItemPrimitive.Delete` rendered by the registry component
`ui/src/components/assistant-ui/thread-list.tsx` (inside the per-row
`ThreadListItemMorePrimitive` dropdown). A 404 is treated as idempotent
success (the row was already gone). The registry's Archive item was
removed during install (server has no archive endpoint).

What happens when the deleted cid is the active one is now decided by
assistant-ui's runtime; see PENDING RECONCILIATION above.
