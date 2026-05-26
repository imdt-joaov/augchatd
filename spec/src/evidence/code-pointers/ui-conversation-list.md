---
id: code-ptr-ui-conversation-list
type: evidence
status: current
source_kind: code
ref: "ui/src/ConversationList.tsx:36-55@87a4d97"
proves: technical-contract-http-get-conversations
---

The bundled SPA consumes `GET /conversations` from a left-sidebar
component. On mount and whenever the parent's `refetchKey` changes,
the component issues an authed GET, expects `{ conversations: [...] }`,
and renders each row using `title` (with a "Sem título" fallback when
`null`), `updated_at` (formatted via `Intl.RelativeTimeFormat`), and
`conversation_id` (used to select / delete the row). The contract's
`title: string | null` and `updated_at: string (ISO 8601)` shapes are
load-bearing for this rendering.
