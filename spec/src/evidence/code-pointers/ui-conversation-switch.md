---
id: code-ptr-ui-conversation-switch
type: evidence
status: current
source_kind: code
ref: "ui/src/App.tsx:switchConversation@87a4d97"
proves: technical-contract-http-get-conversation-messages
---

The bundled SPA loads a conversation's stored messages through
`GET /conversations/:cid/messages` from the App-level
`switchConversation` action (triggered by clicking a sidebar row).
The `messages[]` are mapped 1:1 into assistant-ui's `UIMessage` shape
(`message_id → id`, `role`, `parts`, optional `metadata`); the iframe
route is updated and the React subtree rooted at `ChatRoom` is
re-keyed by the new cid so the chat runtime hydrates fresh.
