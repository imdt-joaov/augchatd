---
id: technical-contract-browser-postmessage
type: technical-contract
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "README header (iframe snippet) / UI integration"
  - source: ui/src/App.tsx
    section: "requestJwtFromParent / getParentOrigin"
  - source: src/routes/demo-page.ts
    section: "iframePathFromParent — appends ?parent_origin="
links:
  - relation: supports
    target: contract-ui-handshake
---

# Technical contract — Browser `postMessage` handshake

## Direction A — iframe → parent page

```
{ "type": "augchatd:ready" }
```

Posted by the bundled UI on boot to obtain the initial JWT AND on any subsequent `401` to obtain a fresh one. The parent responds with `augchatd:jwt` each time.

```
{ "type": "augchatd:route", "path": "/c/<conversation_id>" }
```

Posted whenever the iframe changes its internal route (e.g. when minting a fresh conversation). The parent SHOULD record the path in its own URL so a hard reload restores the iframe to the same route. How (pathname, fragment, query, none) is the parent's choice — the iframe does not care. The demo wrapper mirrors it into its pathname as `/demo<path>`.

## Direction B — parent page → iframe

```
{ "type": "augchatd:jwt", "jwt": "eyJ...", "theme": "light" }
```

Posted in response to each `augchatd:ready`. The `theme` field is OPTIONAL — `"light"` (default) or `"dark"`; the iframe applies it to its document root if present.

## Origin checking

- The iframe targets the parent's origin when sending `augchatd:ready` / `augchatd:route`.
- The parent **must** verify `event.origin` equals the augchatd origin before responding to `augchatd:ready`.
- The parent **must** target the augchatd origin when sending `augchatd:jwt`.
- The iframe **must** verify `event.origin` equals its expected parent origin before accepting `augchatd:jwt`.

### Iframe-side parent-origin discovery

The integrator embeds the iframe with a `?parent_origin=<their-origin>` query string on the `src`, e.g.:

```html
<iframe src="https://augchatd.your-infra/?parent_origin=https://app.example.com"></iframe>
```

The iframe parses `?parent_origin=` once, validates it via `new URL(...)`, and uses the resulting `.origin` as the `targetOrigin` for outbound `postMessage` calls AND as the strict comparison value when filtering inbound `augchatd:jwt`. The demo wrapper (`/demo/`) sets this query string automatically on the iframe `src`, so demo exercises the strict path.

**Degrade mode (back-compat).** If `?parent_origin=` is absent or unparseable, the iframe falls back to `document.referrer`'s origin and logs a one-time `console.warn`. Integrators should not rely on this fallback — it exists so embedders updated before this contract land continue working.

(The README snippet demonstrates the parent side via `if (e.origin !== 'https://augchatd.your-infra') return;`.)

## Message contract

| Field | Type | Where | Meaning |
| --- | --- | --- | --- |
| `type` | string | all | `augchatd:ready`, `augchatd:jwt`, or `augchatd:route` |
| `jwt` | string | `augchatd:jwt` | opaque token |
| `theme` | `"light"` \| `"dark"` | `augchatd:jwt` (optional) | UI palette; absent ⇒ `"light"` |
| `path` | string | `augchatd:route` | the iframe's new internal path (e.g. `/c/<cid>`) |

## Related

- Behavior: [ui-handshake](../behavior/contracts/ui-handshake.md)
- Behavior: [jwt-refresh](../behavior/contracts/jwt-refresh.md)
