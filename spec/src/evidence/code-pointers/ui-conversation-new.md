---
id: code-ptr-ui-conversation-new
type: evidence
status: current
source_kind: code
ref: "ui/src/lib/threadListAdapter.tsx:createThreadListAdapter.initialize@WIP"
proves: technical-contract-http-post-conversations
---

> [!NOTE] Pending commit
> The `@WIP` marker is a placeholder until the assistant-ui ThreadList
> refactor lands. Bump to the merge commit when the branch
> `improvements` is squashed onto `main`.

The bundled SPA mints fresh conversations through `POST /conversations`
from the `RemoteThreadListAdapter.initialize()` method in
`ui/src/lib/threadListAdapter.tsx`. The body is `{}` (no client-supplied
id); the response's `conversation_id` is returned as `remoteId`.

Trigger points:

1. **New Thread button** — `ThreadListPrimitive.New` in
   `ui/src/components/assistant-ui/thread-list.tsx` creates a local-only
   thread; the per-thread `useAugchatdChatRuntime` hook in
   `ui/src/App.tsx` calls `aui.threadListItem().initialize()` eagerly on
   mount, which routes through our adapter and POSTs.
2. **Boot with empty URL** — when `/c/<cid>` is absent, the runtime
   mounts a default local thread; the same eager `initialize()` fires.
3. **Boot with `/c/<cid>` for an unknown cid** — the runtime first calls
   `adapter.fetch(cid)`; on failure (cid not in `list()`) the runtime
   falls back to a default thread, which then `initialize()`s a fresh one.

The eager call is idempotent (assistant-ui caches the `initializeTask`
per thread), so threads loaded via `adapter.list()` do not re-POST.
The URL is updated to `/c/<conversation_id>` by the `UrlSync` effect in
`App.tsx`, which fires whenever `s.threadListItem.remoteId` changes.
