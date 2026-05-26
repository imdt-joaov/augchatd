---
id: adr-0009-react-vite-bundled-ui
type: adr
status: current
evidence:
  - source: README.md
    section: "Status (stack listing)"
  - source: ui/package.json@06313ae
    section: "react ^18, vite ^5, @assistant-ui/react, tailwindcss ^3"
  - source: ui/vite.config.ts@06313ae
    section: "Vite build → ui/dist consumed by src/routes/static-ui.ts"
  - source: ui/src/App.tsx@06313ae
    section: "Bundled UI entry point"
links:
  - relation: supports
    target: req-007-bundled-ui
  - relation: refines
    target: adr-0001-single-binary-bundled-ui
---

# ADR 0009 — Bundled UI is a React SPA built with Vite, embedding assistant-ui, served as static assets

## Context

[ADR-0001](0001-single-binary-bundled-ui.md) commits augchatd to serving the chat UI from the same binary as the JSON API. The remaining question is the framework/tooling for the UI itself.

The constraints on that choice:

- The UI's central component is **assistant-ui** (React-based, [adr-0006](0006-vercel-ai-sdk-for-llm.md) — its stream protocol is the Vercel AI SDK data stream).
- The output must be **static assets** (HTML/CSS/JS) that the Hono server (running in Bun, [adr-0007](0007-bun-hono-typescript.md)) can serve from the same origin as the JSON API. Anything that requires a Node SSR runtime conflicts with the "single binary" promise.
- The UI is a logged-in SPA inside an iframe. There is **no SEO, no SSR, no server-side rendering need**.
- Build complexity should stay low; the UI is a feature, not a frontend product.
- Local iteration on the UI must remain ergonomic for a frontend developer.

## Decision

Build the bundled UI as a **React Single-Page Application using Vite**. The Vite build emits static HTML/CSS/JS, which is compiled into the augchatd binary and served from `/` by the same Hono process that serves the JSON API.

Routing inside the UI uses a small client-side library (e.g. `react-router`); there is no server-side routing.

## Consequences

- assistant-ui's React ergonomics carry without exotic adaptation.
- Vite's static output is exactly what the Hono static-file serving needs — no Node runtime ships in the binary.
- The UI is a single artifact alongside the backend; no separate `npm publish` lane, no separate version to coordinate.
- Frontend developers iterate locally with `vite dev` (HMR, fast); the binary serves the production build.
- Upgrading the UI ships in the same release as the backend.

## Alternatives considered

- **Next.js (`output: 'standalone'`)** — initially picked, but `standalone` mode produces a Node-runtime bundle expecting `node server.js`. Embedding that inside a Bun binary either requires running Node inside Bun (defeats single-binary) or doesn't actually use the standalone features. We do not need SSR, RSC, server actions, image optimization, or file-system server routing — all the things Next.js does that React-with-Vite does not. The mismatch between "Next.js standalone" semantics and "Bun-served static SPA" was the original decision error this ADR replaces.
- **Next.js (`output: 'export'`)** — would technically work (pure static export). Rejected for added build complexity over plain Vite for a SPA we don't need Next.js features for.
- **CRA (Create React App)** — deprecated upstream.
- **Webpack-direct or Rollup-direct** — Vite wraps these with sensible defaults; no benefit to going lower-level.
- **assistant-ui from a CDN via `<script>`** — would couple integrators to a CDN and defeat the single-binary-same-origin guarantee.

## Note on choice of routing / state libraries

This ADR commits to React + Vite + static output. It does **not** commit to specific choices of router, state management, or styling — those are implementation details inside the UI subproject. They will be recorded as comments in code when the UI is built.

## Realized choices (post-implementation)

The UI subproject landed on branch `impl-demo-mode` with the following stack. Recorded here for posterity; future swaps within the same family (e.g. Tailwind v3 → v4) do not require an ADR revision.

- **Styling: Tailwind CSS v3 utility-first.** No CSS-in-JS, no styled-components.
- **Theme: CSS variables (shadcn-style).** Light is the `:root` default; dark is `[data-theme="dark"]` override. The bundled UI sets the attribute on the document root from the value supplied via the `postMessage` handshake (per [contract-ui-handshake](../../behavior/contracts/ui-handshake.md)).
- **Component primitives: `@assistant-ui/react` primitives composed manually** (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`, etc.). No Radix / React Aria wrappers — the bundled UI styles the primitives directly with Tailwind utilities.
- **Routing: client-side via `window.history.replaceState`** (no `react-router` — the convention `/c/<conversation_id>` is the entire surface; see [contract-ui-handshake#augchatd:route](../../contracts/browser-postmessage.md)).
- **Markdown rendering: `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `rehype-highlight` + `rehype-raw` + `rehype-sanitize`** (with an extended schema allowing inline SVG). See [contract-ui-rendering](../../behavior/contracts/ui-rendering.md) for the full renderer catalog.

> [!IMPORTANT] PENDING RECONCILIATION — shadcn layering on top of primitives
> The bullet "**Component primitives: `@assistant-ui/react` primitives composed manually** … No Radix / React Aria wrappers — the bundled UI styles the primitives directly with Tailwind utilities" is partially outdated after the ThreadList refactor:
>
> - The sidebar shell is now `ThreadListSidebar` from the assistant-ui shadcn registry, copied into `ui/src/components/assistant-ui/threadlist-sidebar.tsx` and customized in place.
> - It renders `<ThreadList />` (also from the registry, in `thread-list.tsx`) which wraps `ThreadListPrimitive` / `ThreadListItemPrimitive` / `ThreadListItemMorePrimitive` with shadcn `Button`, `Skeleton`, and `Sidebar*` shells.
> - Those shadcn components are built on Radix Primitives (`@radix-ui/react-*`), so the "No Radix" clause is no longer literally true.
> - Thread-state ownership moved from custom App-level callbacks (`ConversationList.tsx`, `App.tsx:newConversation/switchConversation/deleteConversation`) into assistant-ui via `useRemoteThreadListRuntime` + a `RemoteThreadListAdapter` (`ui/src/lib/threadListAdapter.tsx`) that targets the same `/conversations*` REST surface.
>
> Proposed direction: **update the spec** — promote the layering to an explicit choice. Two options:
>
> 1. Rewrite this bullet to read: "Component primitives: `@assistant-ui/react` primitives composed manually, **with the `Thread*` family for the chat surface and the assistant-ui shadcn registry components (`threadlist-sidebar`, `thread-list`) for the thread list — those wrap `Sidebar` / `Button` / `Skeleton` from shadcn, which use Radix under the hood**. The bundled UI customizes installed registry files in place rather than re-skinning at the consumer side."
> 2. Or, spin a fresh ADR (e.g. `0012-shadcn-for-non-thread-ui.md`) since "we now consume two registries (assistant-ui + shadcn)" is a coordination decision (component upgrades, customization model) and not just a styling tweak.
>
> Decision deferred to a human review pass.
