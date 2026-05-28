import { jsonSchema, tool, type Tool } from "ai";
import type { RagConnector } from "./connectors.ts";

/**
 * RAG dispatch for OpenSearch-backed connectors.
 *
 * Per contract-rag-query / contract-mcp-invocation parity:
 *  - One AI SDK tool per active RAG-type connector, named
 *    `<descriptive_id>__retrieve`.
 *  - The tool input is `{ query, top_k? }`; the connector's allowed
 *    `indexes[]` is fixed at session creation and applied **before**
 *    query construction (LLM cannot escape the scope — the URL we hit
 *    is `<cluster>/<indexes joined>/_search`).
 *  - First cut uses lexical BM25 via OpenSearch `query_string` over all
 *    fields. The spec calls for hybrid BM25 + kNN; that requires the
 *    cluster to have a neural search model deployed (ML Commons + neural
 *    pipeline) and is left for follow-up.
 *
 * Init: a quick `GET /` probe at boot. Connect failure is logged-and-
 * skipped (optional dependency — chat still works without retrieval).
 */

export interface ConnectedRag {
  connector: RagConnector;
  baseHeaders: Record<string, string>;
  tools: Record<string, Tool>;
}

const DEFAULT_TOP_K = 5;

/**
 * Structured per-hit data captured for the UI side-channel.
 *
 * The retrieve tool's text return goes to the LLM (so it can ground).
 * In parallel we stash these structured records under the toolCallId so
 * the chat handler can emit `source-document` UI parts after the tool
 * result lands — assistant-ui then renders a chip per hit beneath the
 * message, no inline parenthetical citation needed.
 */
export interface RagHit {
  source_descriptive_id: string;
  index: string;
  doc_id: string;
  score: number | null;
  title: string;
  snippet: string;
}

/**
 * Read and remove the hits stored for `toolCallId` from the per-session
 * `hitsMap`. The chat handler calls this once per retrieve tool result
 * inside `onStepFinish`. Any hits left behind would be a memory leak —
 * the Map is cleared on read.
 */
export function consumeRagHits(
  hitsMap: Map<string, RagHit[]>,
  toolCallId: string,
): RagHit[] {
  const hits = hitsMap.get(toolCallId) ?? [];
  hitsMap.delete(toolCallId);
  return hits;
}

export async function initRagConnectors(
  connectors: RagConnector[],
  clientsOut: Map<string, ConnectedRag>,
  hitsOut: Map<string, RagHit[]>,
): Promise<void> {
  for (const c of connectors) {
    try {
      // hitsOut is captured by the retrieve tool's `execute` closure (see
      // connectRag), so each per-session client writes hits into the
      // session's own Map — never into a module-level singleton.
      const conn = await connectRag(c, hitsOut);
      clientsOut.set(c.descriptive_id, conn);
      console.log(
        `  rag[${c.descriptive_id}] connected (${c.backend}), indexes: ${c.indexes.join(", ")}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  rag[${c.descriptive_id}] connect failed: ${msg}`);
    }
  }
}

async function connectRag(
  c: RagConnector,
  hitsMap: Map<string, RagHit[]>,
): Promise<ConnectedRag> {
  const baseHeaders = buildAuthHeaders(c.auth);
  baseHeaders["Content-Type"] = "application/json";

  // Probe: GET / against the cluster. If unreachable or auth-rejected,
  // we throw and the connector is skipped.
  const probe = await fetch(c.cluster, {
    method: "GET",
    headers: baseHeaders,
  });
  if (!probe.ok) {
    throw new Error(`cluster probe HTTP ${probe.status}: ${await probe.text().catch(() => "")}`);
  }

  const indexesPath = c.indexes.map(encodeURIComponent).join(",");

  const langClause = c.language
    ? ` IMPORTANT: this corpus is in ${c.language}. ALWAYS write the query in ${c.language}, translating from the user's language if needed. Lexical search will return zero results if the query language doesn't match the corpus.`
    : "";
  const corpusClause = c.description
    ? `\n\nCorpus contents: ${c.description}`
    : "";
  const retrieveTool = tool({
    description:
      `Retrieve up to top_k passages from the "${c.name}" knowledge base ` +
      `(${c.backend} indexes: ${c.indexes.join(", ")}). Use this whenever ` +
      `you need supporting facts or quotes from this corpus. Input is a ` +
      `natural-language query.${langClause}${corpusClause}`,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        top_k: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: DEFAULT_TOP_K,
          description: "Maximum number of passages to return.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (rawInput, { toolCallId, abortSignal }) => {
      const input = rawInput as { query: string; top_k?: number };
      const top_k = Math.min(20, Math.max(1, input.top_k ?? DEFAULT_TOP_K));
      const body = {
        size: top_k,
        // Drop vectors and other big binary-ish fields from the response.
        // The LLM sees text + metadata; the vector lives only on the
        // server side for ranking.
        _source: {
          excludes: ["embedding", "vector", "_vector", "embeddings"],
        },
        // multi_match over the text field (weighted) and a known
        // metadata title field. `best_fields` ranks by the best-matching
        // single field; `minimum_should_match: 50%` requires roughly half
        // the query terms — strict enough to filter noise, loose enough
        // for natural-language questions to find something.
        // `default_operator: AND` (the first cut) was too strict — a
        // 5-word question that's slightly off-corpus returned zero hits.
        query: {
          multi_match: {
            query: input.query,
            fields: ["text_content^2", "metadata.item_name"],
            type: "best_fields",
            minimum_should_match: "50%",
          },
        },
      };
      const url = `${c.cluster}/${indexesPath}/_search`;
      const r = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(body),
        signal: abortSignal,
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return `retrieval error: HTTP ${r.status} ${text.slice(0, 200)}`;
      }
      const data = (await r.json()) as OpenSearchResponse;
      // Capture structured hits for the UI side-channel into the
      // session-owned Map captured at session creation. The chat
      // handler reads these in onStepFinish and emits one
      // source-document part per hit (see consumeRagHits + chat.ts).
      hitsMap.set(toolCallId, parseHitsForUi(data, c));
      return formatHits(data, c.indexes);
    },
  });

  return {
    connector: c,
    baseHeaders,
    tools: { [`${c.descriptive_id}__retrieve`]: retrieveTool },
  };
}

function buildAuthHeaders(auth: Record<string, unknown>): Record<string, string> {
  if (typeof auth.bearer === "string") {
    return { Authorization: `Bearer ${auth.bearer}` };
  }
  if (typeof auth.basic === "object" && auth.basic !== null) {
    const b = auth.basic as { username?: unknown; password?: unknown };
    if (typeof b.username !== "string" || typeof b.password !== "string") {
      throw new Error('auth.basic requires { username: string, password: string }');
    }
    const encoded = Buffer.from(`${b.username}:${b.password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  throw new Error('auth: expected { bearer: "..." } or { basic: { username, password } }');
}

interface OpenSearchHit {
  _index: string;
  _id: string;
  _score: number | null;
  _source: Record<string, unknown>;
}
interface OpenSearchResponse {
  hits: { total?: { value: number }; hits: OpenSearchHit[] };
}

function formatHits(data: OpenSearchResponse, indexes: string[]): string {
  const hits = data.hits?.hits ?? [];
  if (hits.length === 0) {
    return `No results in indexes [${indexes.join(", ")}].`;
  }
  const lines = hits.map((h, i) => {
    const score = h._score?.toFixed(3) ?? "?";
    const body = formatSource(h._source);
    return `[${i + 1}] index=${h._index} id=${h._id} score=${score}\n${body}`;
  });
  return `Top ${hits.length} hit${hits.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`;
}

const TEXT_FIELD_CANDIDATES = ["text_content", "text", "content", "body", "chunk", "passage"];
const MAX_TEXT_CHARS = 1200;
const MAX_META_CHARS = 400;

function formatSource(src: Record<string, unknown>): string {
  // Pull a recognizable text field first; LLM context is cheap on tokens but
  // not free, so we cap it. Everything else (metadata) goes after, capped
  // tighter. The full _source is never blindly dumped — that's what bit the
  // first cut: embeddings (when present despite excludes) or other big
  // numeric arrays ate the budget before the LLM saw any text.
  const parts: string[] = [];
  let primaryKey: string | undefined;
  for (const k of TEXT_FIELD_CANDIDATES) {
    const v = src[k];
    if (typeof v === "string" && v.length > 0) {
      primaryKey = k;
      parts.push(`${k}: ${truncate(v, MAX_TEXT_CHARS)}`);
      break;
    }
  }
  // Metadata: everything else except known noisy/redundant fields.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === primaryKey) continue;
    if (k === "embedding" || k === "vector" || k === "_vector" || k === "embeddings") continue;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "number") continue; // looks like a vector
    rest[k] = v;
  }
  if (Object.keys(rest).length > 0) {
    parts.push(`metadata: ${truncate(JSON.stringify(rest), MAX_META_CHARS)}`);
  }
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "… [truncated]";
}

const TITLE_FIELD_CANDIDATES = ["title", "name", "item_name"];
const MAX_TITLE_CHARS = 80;
const MAX_SNIPPET_CHARS = 300;

function parseHitsForUi(data: OpenSearchResponse, c: RagConnector): RagHit[] {
  const hits = data.hits?.hits ?? [];
  return hits.map((h) => {
    const src = h._source;
    // Title: prefer a real title-ish field; fall back to a snippet of
    // text; final fallback is the doc id (always non-empty).
    let title: string | undefined;
    for (const k of TITLE_FIELD_CANDIDATES) {
      const v = src[k];
      if (typeof v === "string" && v.length > 0) {
        title = truncate(v, MAX_TITLE_CHARS);
        break;
      }
    }
    // metadata-nested title (e.g. metadata.item_name) — common in the
    // corpora we hit so far.
    if (!title && typeof src["metadata"] === "object" && src["metadata"] !== null) {
      const meta = src["metadata"] as Record<string, unknown>;
      for (const k of TITLE_FIELD_CANDIDATES) {
        const v = meta[k];
        if (typeof v === "string" && v.length > 0) {
          title = truncate(v, MAX_TITLE_CHARS);
          break;
        }
      }
    }
    if (!title) {
      for (const k of TEXT_FIELD_CANDIDATES) {
        const v = src[k];
        if (typeof v === "string" && v.length > 0) {
          title = truncate(v, MAX_TITLE_CHARS);
          break;
        }
      }
    }
    if (!title) title = h._id;

    // Snippet: a longer slice of the text field for the expand-on-click view.
    let snippet = "";
    for (const k of TEXT_FIELD_CANDIDATES) {
      const v = src[k];
      if (typeof v === "string" && v.length > 0) {
        snippet = truncate(v, MAX_SNIPPET_CHARS);
        break;
      }
    }

    return {
      source_descriptive_id: c.descriptive_id,
      index: h._index,
      doc_id: h._id,
      score: h._score,
      title,
      snippet,
    };
  });
}

export function toolsForActiveRagConnectors(
  clients: Map<string, ConnectedRag>,
  connectors: RagConnector[],
  activeMap?: Map<string, boolean>,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const c of connectors) {
    const active = activeMap ? (activeMap.get(c.descriptive_id) ?? c.default_active) : c.default_active;
    if (!active) continue;
    const entry = clients.get(c.descriptive_id);
    if (!entry) continue;
    Object.assign(out, entry.tools);
  }
  return out;
}
