---
id: contract-rag-query
type: behavior-contract
status: proposed
capability: cap-chat
evidence:
  - source: README.md@e562b2b
    section: "What augchatd does (Runs retrieval) / What augchatd does NOT do (ingest)"
  - source: README.md
    section: "README header (connectors paragraph)"
links:
  - relation: satisfies
    target: req-002-rag-scoping
  - relation: depends_on
    target: contract-session-chat
  - relation: depends_on
    target: contract-connector-toggle
  - relation: constrains
    target: contract-session-create
  - relation: refines
    target: adr-0010-unified-connector-model
---

# Contract — RAG retrieval

> [!WARNING] PENDING RECONCILIATION
> - **Detected**: 2026-05-25 by /code-changed (audit consolidation, augchatd/augchatd#9 §C5)
> - **Sources in conflict**: this contract's Promise §1 ("hybrid BM25 + kNN, native") + glossary entry + `components.md` diagram vs `src/rag.ts:140-148` (lexical `multi_match best_fields` only; no kNN, no neural pipeline, no embedding step).
> - **Nature**: hybrid means combining lexical (BM25) with vector (kNN) similarity and merging scores. Today augchatd does BM25 only. The per-RAG-connector `language` hint exists precisely because lexical search cannot bridge languages — a workaround that hybrid would obsolete. Each document also lacks a `knn_vector` field, so even switching the query body to a `hybrid` shape would return zero kNN matches against the current indexes.
> - **Proposed direction**: phase 1 (this block) makes the divergence explicit without code change. Phases 2 and 3 are tracked separately — phase 2 wires cluster-side embedding via OpenSearch ML Commons (the managed DigitalOcean OpenSearch our demo runs against ships the `opensearch-ml` + `opensearch-knn` + `opensearch-neural-search` plugins pre-installed, but no model is registered and no pipeline configured), and requires re-indexing the corpus through a text-embedding ingest pipeline. Phase 3 adds an optional `embedding: { url, auth, model }` field on the RAG connector for integrators who run a cluster without ML Commons and prefer external embedding.
> - **Decision owner**: project owner.

## Promise

When a conversation has one or more **active RAG-type connectors** (active state is per-conversation; see [contract-connector-toggle](connector-toggle.md)) and the LLM invokes the retrieval tool exposed by one of them during a chat turn, augchatd:

1. Resolves the backend kind from the connector's `backend` field — currently always `"opensearch"` (hybrid BM25 + kNN, native). pgvector is a future option (see [pressure-pgvector-backend](../../pressure/pgvector-backend.md)).
2. Builds a query constrained to **that connector's `indexes[]`**.
3. Authenticates with that connector's `auth` credentials against the connector's `cluster`.
4. Returns hits to the LLM, tagged with the connector's `descriptive_id` so the LLM (and the streamed indicator) know which knowledge base they came from.
5. **Emits a `source-document` UI part per hit** into the chat stream, carrying `providerMetadata.augchatd = { source_descriptive_id, index, doc_id, score, snippet }`. The bundled UI renders each as a clickable chip beneath the assistant message — the LLM is therefore not expected to paste inline parenthetical citations (which become redundant noise).

> [!NOTE] Implementation pattern — per-part, not panel
> An earlier attempt rendered RAG sources via a global `CitationsPanel` driven by a `useThread((t) => collectSources(t.messages))` selector — that selector returned a fresh array each render and tripped React error #185 ("Maximum update depth exceeded"). The shipped pattern emits the chips as ordinary message parts instead: the retrieve tool captures `RagHit[]` into a **per-session** side-channel map keyed by `toolCallId` (the session-owned `ragHitsByToolCall` Map; the retrieve tool's `execute` closure captures the session's Map at session-creation time, so credentials and intermediate results never leave the session boundary); the chat handler's `onStepFinish` drains that map and writes one `source-document` `UIMessagePart` per hit into the stream. Each hit thus rides as a part on the assistant message it came from — the UI just renders parts in order, no thread-wide selectors needed.

Scope is applied **before** query construction. The LLM cannot express a query that escapes the connector's `indexes[]`; the tool surface only exposes that set. RAG-type connectors **inactive for the current conversation** are not exposed to the LLM at the start of the turn (active state is per-conversation; see [contract-connector-toggle](connector-toggle.md)).

## Observable outcomes

- A query captured at the backend lists only the connector's allowed indexes.
- Two concurrent sessions with disjoint RAG connectors against the same OpenSearch cluster produce disjoint captured queries.
- An LLM tool call naming a disallowed index produces either a refusal or a query restricted to the active connector's allowed set.
- A session with two active RAG connectors (e.g. `rag_public` and `rag_internal`) exposes each one to the LLM with its own scope; each query is scoped to that connector's indexes.
- A RAG-type connector toggled off is absent from the tool list of the next chat turn.

## Non-promises

- augchatd does not ingest, chunk, or embed documents.
- augchatd does not rank or re-rank cross-connector; that is the backend's (or the LLM's) responsibility.
- augchatd does not support pgvector today; the `backend` enum only accepts `"opensearch"`.

## Tests this contract implies

- OpenSearch hybrid query for a connector with two allowed indexes — captured query lists exactly those two.
- A session with two active RAG connectors hits each backend independently with its own credentials and indexes.
- Negative test: LLM tool call mentioning an index not in any active connector's `indexes[]` — assertion that no outbound query contains it.
- Toggling a RAG-type connector off for a conversation via `PUT /conversations/:cid/connectors/:descriptive_id` removes its retrieval tool from the next turn of that conversation; it remains exposed for chat against other conversations where the connector is active.
- A connector with `backend: "pgvector"` in the session payload is **rejected at session creation** (unknown backend) — see [contract-session-create](session-create.md).
