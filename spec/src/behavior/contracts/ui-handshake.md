---
id: contract-ui-handshake
type: behavior-contract
status: proposed
capability: cap-ui
evidence:
  - source: README.md@e562b2b
    section: "README header (iframe + postMessage example) / UI integration"
links:
  - relation: satisfies
    target: req-007-bundled-ui
  - relation: depends_on
    target: technical-contract-browser-postmessage
  - relation: enables
    target: contract-session-chat
---

# Contract — UI handshake (iframe ↔ parent page)

## Promise

The bundled UI, loaded inside an `<iframe>` on a parent page (the integrator's app in production, the `GET /demo/` wrapper in demo), performs this handshake:

1. On boot, the iframe sends `postMessage({ type: 'augchatd:ready' }, parentOrigin)` to its parent.
2. The parent listens for that message, verifies the message's `origin` is the augchatd iframe origin, and replies with `postMessage({ type: 'augchatd:jwt', jwt, theme? }, augchatdOrigin)`. `theme` is optional — `"light"` or `"dark"`.
3. The iframe accepts the JWT, applies `theme` if present, and uses the JWT for all subsequent chat calls to the augchatd origin.

Additional messages after the initial handshake:

- **iframe → parent**: `postMessage({ type: 'augchatd:ready' }, parentOrigin)` may be re-emitted whenever the iframe needs a fresh JWT (e.g. after a `401` response). The parent should respond with a new `augchatd:jwt`. The same code path handles initial boot and refresh.
- **iframe → parent**: `postMessage({ type: 'augchatd:route', path }, parentOrigin)` whenever the iframe changes its internal route (e.g. `/c/<cid>` after minting a new conversation). The parent should record the path in its own URL so a reload restores the iframe to the same route. The demo wrapper writes it to its pathname as `/demo<path>`; a production integrator may handle it however its router prefers.

The same handshake runs in both:

- **Production**: parent is the integrator's app page on a different origin; the JWT comes from the integrator's backend via `POST /sessions`.
- **Demo**: parent is the wrapper page at `GET /demo/` on the same origin as the iframe; the JWT comes from `POST /demo/sessions`.

## Observable outcomes

- A page following the README's snippet completes the initial handshake without modification.
- The iframe ignores `augchatd:jwt` messages whose `origin` is not the expected parent origin. The iframe learns the expected origin from `?parent_origin=<origin>` on its own `src` URL (set by the integrator); if missing, it falls back to `document.referrer` with a one-time console warning. See [browser-postmessage](../../contracts/browser-postmessage.md) §Origin checking.
- The parent ignores `augchatd:ready` from any origin other than the augchatd iframe.
- The JWT is never put in the iframe URL, in cookies, or in a query string.
- `augchatd:route` posts from the iframe land at the parent and (in the demo wrapper) update the parent's URL pathname; a subsequent hard reload of the parent URL seeds the iframe at the same route.
- A `401` from any chat-time endpoint causes the iframe to re-emit `augchatd:ready`; the parent's reply with a fresh JWT lets the chat continue.

## Non-promises

- The handshake does not negotiate auth scheme; the JWT is opaque to the parent page.
- The handshake does not establish a heartbeat; expiry handling is the [jwt-refresh](jwt-refresh.md) contract (the iframe just re-emits `augchatd:ready`).
- The handshake is not a public API for custom UIs; the bundled UI is the only supported consumer (see [req-007](../requirements/req-007-bundled-ui.md)).
- The cross-origin variant of the iframe's parent-origin verification reads `?parent_origin=` from the iframe `src` (see [browser-postmessage](../../contracts/browser-postmessage.md) §Origin checking). Integrators who don't pass it get the degraded `document.referrer` fallback — this is back-compat, not a promise.

## Tests this contract implies

- Integration test of the iframe + parent-page snippet from the README.
- Cross-origin negative test: a message from the wrong origin is rejected.
- `augchatd:route` posted from the iframe is observable at the parent.
- A `401` returned by a chat-time endpoint triggers the iframe to re-emit `augchatd:ready` and resume after the parent supplies a new JWT.
- Custom-UI use is documented as unsupported.
