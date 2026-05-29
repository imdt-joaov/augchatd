---
id: constraint-out-of-scope
type: constraint
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "What augchatd does NOT do"
---

# Constraint — Out of scope

**Canonical list of what augchatd refuses to do.** Each non-goal is a deliberate boundary that keeps the daemon small and keeps the integrator's existing systems authoritative — the integrator owns the responsibility, augchatd doesn't grow to cover it.

(This file replaces an earlier `intent/non-goals.md`; both used to carry the same list with different framings, which created drift risk. Now there is one canonical source — this file — categorized below, with each item's alternative location inline.)

## Identity & policy

- **Manage users.** Lives in the integrator's existing app.
- **Decide** which user can use which connector / index / tool. The integrating application resolves policy at session setup; augchatd applies the resolved scope on every message. **Enforcement of an already-resolved scope is in scope; deciding the scope is not.**

## MCP

- **Host MCP servers.** augchatd is a *client* to MCP servers the integrator or third parties operate.
- **Talk to MCPs over stdio.** HTTP/SSE only; wrap stdio MCPs with a bridge such as `mcpo`. See [adr-0004](../architecture/adrs/0004-http-sse-mcp-only.md).

## RAG

- **Ingest, chunk, or embed documents.** External pipeline; integrator's choice. README suggests DigitalOcean Gradient AI for OpenSearch.
- **Support `backend: "pgvector"`** — currently only `"opensearch"` is accepted. pgvector is a future option; see [pressure-pgvector-backend](../pressure/pgvector-backend.md).

## Connectors

- **Allow the end user to add a connector mid-conversation.** The connector list is fixed at session creation; end-user toggles can only narrow it. Re-mint the session to change scope.
- **Configure MCP servers from the browser.** augchatd connectors are provisioned server-side via the mTLS-authenticated `POST /sessions` call. The browser never sees connector URLs, OAuth tokens, or bearer credentials. The assistant-ui upstream offers a browser-managed MCP path (`@assistant-ui/react-mcp` + `McpConfigDialog`); that path is incompatible with our intent ("credentials never seen by the browser"). The canonical augchatd UI for MCP visibility is the toggle-only `ConnectorsMenu`, governed by [contract-connector-toggle](../behavior/contracts/connector-toggle.md) and [adr-0010](../architecture/adrs/0010-unified-connector-model.md).

## Storage & data

- **Store credentials at rest** beyond an active session's lifetime. Credentials live in process memory for the session's lifetime only.
- **Client-side-encrypt conversation history** before writing to cold storage. Configure SSE-S3, SSE-KMS, or equivalent on the customer bucket.

## Agent surface

- **Long-term memory.** Out of scope; augchatd is a tool-use loop, not an agent framework.
- **Planning / autonomous-agent loops.** Same.

## Commercial / operational

- **Bill or meter LLM usage.** The customer's LLM key is billed directly by the provider.
- **Enforce per-tenant rate limits.** Throttle at the edge before minting the session.
- **Ship observability dashboards or metrics.** Logs go to stderr; wire your own collector. See [observability](observability.md).

## Safety / privacy

- **Content moderation.** Run at the integrator's edge or as an MCP-type connector.
- **PII redaction.** Same.

## Rule

If an integrator asks "does augchatd do X?", the spec's answer is **no** unless X appears in [capabilities.md](../behavior/capabilities.md).
