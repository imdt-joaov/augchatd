---
id: code-ptr-ui-conversation-delete
type: evidence
status: current
source_kind: code
ref: "ui/src/App.tsx:deleteConversation@87a4d97"
proves: technical-contract-http-delete-conversations-cid
---

The bundled SPA deletes conversations through `DELETE /conversations/:cid`
from the App-level `deleteConversation` action (triggered by the
per-row ✕ control in the sidebar after a `window.confirm`). A 404 is
treated as idempotent success (the row was already gone). When the
deleted cid matches the active conversation, a fresh one is minted via
`newConversation`; otherwise the sidebar simply refetches.
