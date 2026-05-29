---
id: contract-ui-i18n
type: behavior-contract
status: proposed
capability: cap-ui
evidence: []
links:
  - relation: satisfies
    target: req-007-bundled-ui
  - relation: depends_on
    target: contract-ui-handshake
  - relation: refines
    target: contract-ui-rendering
---

# Contract — UI localization (chrome only)

## Promise

The bundled UI's **chrome** (menus, buttons, tooltips, aria-labels, empty/loading/error states it controls itself) is rendered in the language selected by the integrator via the iframe `src` query parameter:

- `?locale=en` (default; also the result when the param is absent)
- `?locale=fr`

The same channel already carries `?parent_origin=` for the postMessage handshake. `locale` is integrator-set, parallel to `theme` on the handshake reply — both are session-scoped properties chosen outside the UI.

On boot the UI:

1. Reads `?locale=` from `window.location.search`.
2. Normalizes to one of the supported BCP 47 codes (`en`, `fr`). Anything else falls back to `en` with a one-time console warning naming the rejected value.
3. Sets `document.documentElement.lang` to the resolved code.
4. Renders all chrome strings from the selected catalog before first paint.

## Observable outcomes

- `<iframe src=".../?parent_origin=...&locale=fr">` renders the menus, the empty-state card, the composer placeholder, the slash-command list, and the help dialog in French.
- The same URL with `locale=` omitted, or with `locale=xx` (unsupported), renders in English; the latter emits exactly one console warning.
- `document.documentElement.lang` matches the resolved locale (`en` or `fr`) once the iframe has booted.
- The catalogs for `en` and `fr` cover the same key set — no missing keys in either direction at build time.

## Non-promises

- **Message content is not translated.** Assistant turns, model output, connector names, model display names, thread titles, RAG source snippets, and backend error strings are passed through as-is. The locale applies to UI chrome only — see [contract-ui-rendering](ui-rendering.md).
- **No in-UI language picker.** The locale is integrator-controlled at iframe-src time. There is no toggle, no persistence, no `navigator.language` auto-detection.
- **No runtime locale switching.** Changing `locale=` requires the parent to swap the iframe `src` (or reload it). There is no postMessage to flip language mid-session, mirroring how the theme is fixed for the session in [contract-ui-handshake](ui-handshake.md).
- **No library-string overrides.** Default text rendered by `@assistant-ui/react` primitives that the bundled UI does not wrap (e.g. the `BranchPickerPrimitive` count display, certain default action labels) is shown verbatim from the library and is therefore English regardless of `locale=`.
- **No pluralization or ICU.** Today's surface has no plural forms; the implementation uses simple interpolation (`{{count}}`). Adding ICU is a future change.
- **No date / number formatting policy.** Today no timestamps or numerals are formatted in the chrome; if that changes, the formatter contract will be specified separately.

## Tests this contract implies

- Build-time check (or unit test) that `ui/src/locales/en.json` and `ui/src/locales/fr.json` have identical key sets.
- Integration test: load the iframe with `?locale=fr` and snapshot the empty-state, composer Advanced menu, Connectors menu, and slash-command help — every snapshotted string is French.
- Negative test: `?locale=xx` falls back to English and writes one console warning.
- `document.documentElement.lang` matches the resolved locale.

## Related

- [contract-ui-handshake](ui-handshake.md) — `?parent_origin=` sibling, `theme` precedent
- [contract-ui-rendering](ui-rendering.md) — confirms message content is rendered as-is regardless of locale
- [req-007-bundled-ui](../requirements/req-007-bundled-ui.md) — the bundled UI is the only supported client
