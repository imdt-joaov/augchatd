---
id: code-ptr-ui-conversation-new
type: evidence
status: current
source_kind: code
ref: "ui/src/App.tsx:newConversation@f7675bc"
proves: technical-contract-http-post-conversations
---

The bundled SPA mints fresh conversations through `POST /conversations`
from the App-level `newConversation` action (triggered by the sidebar's
"+ Nova" button and by `deleteConversation` when the active cid is
deleted). The body is `{}` (no client-supplied id); the response's
`conversation_id` is hoisted into `boot.cid`, the iframe route is
updated to `/c/<cid>`, and the sidebar list is refetched.
