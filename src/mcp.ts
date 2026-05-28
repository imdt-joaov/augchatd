import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, tool, type Tool } from "ai";
import type { McpConnector } from "./connectors.ts";

/**
 * MCP integration for augchatd.
 *
 * Per contract-mcp-invocation: for each active MCP-type connector, augchatd
 * connects to that connector's HTTP/SSE URL with its credentials, lists the
 * server's tools, and exposes those tools to the LLM at chat time.
 *
 * Ownership of the MCP `Client` + `Transport` is per session (see
 * [adr-...](../spec/src/architecture/) — credentials never leave the session
 * boundary). The caller (session-registry / index boot) provides a
 * `Map<descriptive_id, ConnectedMcp>` that this module populates; chat-time
 * dispatch (`toolsForActiveConnectors`) reads from the same Map.
 * Connections are best-effort: a connector whose server is down at
 * session-create time is logged-and-skipped (optional dependency — chat
 * still works without it).
 */

export interface ConnectedMcp {
  connector: McpConnector;
  client: Client;
  /**
   * Transport reference held so `closeMcpClients` can call
   * `transport.close()` on session teardown — MCP's `Client` does not
   * expose its own close method today, but the SDK's Transport does.
   */
  transport: StreamableHTTPClientTransport;
  tools: Record<string, Tool>;
}

export async function initMcpConnectors(
  connectors: McpConnector[],
  out: Map<string, ConnectedMcp>,
): Promise<void> {
  for (const c of connectors) {
    try {
      const conn = await connectMcp(c);
      out.set(c.descriptive_id, conn);
      const toolNames = Object.keys(conn.tools);
      console.log(
        `  mcp[${c.descriptive_id}] connected, tools: ${toolNames.length ? toolNames.join(", ") : "(none)"}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  mcp[${c.descriptive_id}] connect failed: ${msg}`);
      // Skip — optional dependency. Chat still works without this connector.
    }
  }
}

/**
 * Tear down every connection in `clients`. Used by DELETE /sessions/:id
 * to release the per-session credentials + sockets. Errors during close
 * are swallowed: the session is going away regardless, and a transport
 * that refuses to close is not actionable here.
 */
export async function closeMcpClients(
  clients: Map<string, ConnectedMcp>,
): Promise<void> {
  for (const [, conn] of clients) {
    try {
      await conn.transport.close();
    } catch {
      // best-effort
    }
  }
  clients.clear();
}

async function connectMcp(c: McpConnector): Promise<ConnectedMcp> {
  const headers = buildAuthHeaders(c.auth);

  const transport = new StreamableHTTPClientTransport(new URL(c.url), {
    requestInit: { headers },
  });

  const client = new Client(
    { name: "augchatd", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: Record<string, Tool> = {};
  const skippedWrites: string[] = [];
  const skippedUnannotated: string[] = [];
  for (const t of listed.tools) {
    if (c.read_only && !isReadOnlyTool(t)) {
      if (t.annotations?.readOnlyHint === false || t.annotations?.destructiveHint === true) {
        skippedWrites.push(t.name);
      } else {
        skippedUnannotated.push(t.name);
      }
      continue;
    }
    const namespaced = `${c.descriptive_id}__${t.name}`;
    const baseDesc = t.description ?? `MCP tool ${t.name} (via ${c.descriptive_id})`;
    const description = c.description
      ? `[${c.name}: ${c.description}]\n\n${baseDesc}`
      : baseDesc;
    tools[namespaced] = tool({
      description,
      inputSchema: jsonSchema(t.inputSchema as object),
      execute: async (input, { abortSignal }) => {
        try {
          const result = (await client.callTool(
            { name: t.name, arguments: input as Record<string, unknown> },
            undefined,
            { signal: abortSignal },
          )) as unknown;
          return flattenResult(result);
        } catch (err) {
          // Detect upstream 401 (the connector's auth has expired or was
          // revoked). Return a sentinel string the chat handler recognizes;
          // it emits a UI data part + trace event so the bundled UI can
          // (eventually) trigger refresh-and-retry the same way it does for
          // augchatd's own JWT 401. See contract-jwt-refresh PENDING block.
          // The LLM also sees this string in the tool result and tends to
          // surface the auth issue to the user in its reply.
          if (isUpstreamUnauthorized(err)) {
            return upstreamUnauthorizedSentinel(c.descriptive_id, err);
          }
          throw err;
        }
      },
    });
  }
  if (skippedWrites.length > 0) {
    console.log(
      `  mcp[${c.descriptive_id}] read_only=true: skipped ${skippedWrites.length} write tool(s) (server-declared): ${skippedWrites.slice(0, 6).join(", ")}${skippedWrites.length > 6 ? ", …" : ""}`,
    );
  }
  if (skippedUnannotated.length > 0) {
    console.log(
      `  mcp[${c.descriptive_id}] read_only=true: skipped ${skippedUnannotated.length} unannotated tool(s) (no readOnlyHint set): ${skippedUnannotated.slice(0, 6).join(", ")}${skippedUnannotated.length > 6 ? ", …" : ""}`,
    );
  }

  return { connector: c, client, transport, tools };
}

/**
 * Tools exposed to the LLM for the current turn, filtered by the active set.
 *
 * `activeMap` (if provided) is the conversation's per-turn snapshot built
 * by conversation-registry.snapshotActiveMap — it OVERRIDES each connector's
 * `default_active`. When absent (e.g. an internal caller without a
 * conversation in hand), we fall back to `default_active`.
 */
export function toolsForActiveConnectors(
  clients: Map<string, ConnectedMcp>,
  connectors: McpConnector[],
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

/**
 * Read-only tool classifier.
 *
 * Trust the MCP server's own declaration via the tool annotations defined in
 * the MCP spec (`readOnlyHint`, `destructiveHint`). No name-based guessing —
 * heuristics produce false positives/negatives and are not a safety boundary.
 *
 * Strict semantics under `read_only: true`:
 *   - Allow only when the server explicitly set `readOnlyHint === true`.
 *   - Block everything else (including unannotated tools and tools where
 *     `destructiveHint === true`).
 *
 * If a server you trust doesn't annotate, fix that server-side. As an escape
 * hatch, set `read_only: false` on the connector to disable the gate
 * entirely — that's the integrator opting in to writes explicitly.
 */
function isReadOnlyTool(t: {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): boolean {
  return t.annotations?.readOnlyHint === true;
}

/**
 * Build outbound request headers from the connector's auth object.
 * Accepted shapes (matching the RAG side, see src/rag.ts):
 *   - { bearer: "..." }                  → Authorization: Bearer ...
 *   - { basic: { username, password } }  → Authorization: Basic base64(user:pass)
 *   - { headers: { "X-...": "..." } }    → forwarded as-is (arbitrary header set)
 * Shapes combine: e.g. { bearer, headers } is allowed; later ones win on
 * collision.
 */
function buildAuthHeaders(auth: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof auth.bearer === "string") {
    out["Authorization"] = `Bearer ${auth.bearer}`;
  }
  if (typeof auth.basic === "object" && auth.basic !== null) {
    const b = auth.basic as { username?: unknown; password?: unknown };
    if (typeof b.username === "string" && typeof b.password === "string") {
      const enc = Buffer.from(`${b.username}:${b.password}`).toString("base64");
      out["Authorization"] = `Basic ${enc}`;
    }
  }
  if (typeof auth.headers === "object" && auth.headers !== null) {
    for (const [k, v] of Object.entries(auth.headers as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * Heuristic: did the upstream MCP server return a 401?
 *
 * The MCP TypeScript SDK propagates transport-level HTTP errors with the
 * status code in the thrown error's message (e.g. "HTTP 401" /
 * "Unauthorized"). We do not have a stable error class to instanceof
 * against across SDK versions, so message-pattern matching is the
 * pragmatic check. False positives are tolerable — the chat handler
 * surfaces the sentinel as a recoverable condition, not a hard failure.
 */
function isUpstreamUnauthorized(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b401\b|unauthor/i.test(err.message);
}

/**
 * Sentinel string returned from the tool's `execute` when an MCP call
 * 401s. Recognizable by the chat handler's `onStepFinish` for in-stream
 * surfacing; also readable by the LLM, which tends to translate it into
 * a user-facing message.
 */
const UPSTREAM_UNAUTHORIZED_PREFIX = "[augchatd:upstream_unauthorized:";

export function isUpstreamUnauthorizedSentinel(s: unknown): string | null {
  if (typeof s !== "string" || !s.startsWith(UPSTREAM_UNAUTHORIZED_PREFIX)) return null;
  const close = s.indexOf("]");
  if (close < 0) return null;
  return s.slice(UPSTREAM_UNAUTHORIZED_PREFIX.length, close);
}

function upstreamUnauthorizedSentinel(descriptive_id: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${UPSTREAM_UNAUTHORIZED_PREFIX}${descriptive_id}] ${msg}`;
}

function flattenResult(result: unknown): string {
  // MCP CallToolResult is { content: [{type:"text",text:"..."},{type:"image",...}] }
  // or, for legacy servers, { toolResult: <anything> }.
  if (typeof result !== "object" || result === null) return JSON.stringify(result);
  const r = result as { content?: unknown; toolResult?: unknown };
  if (Array.isArray(r.content)) {
    const texts = (r.content as Array<Record<string, unknown>>)
      .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
      .map((c) => c["text"] as string);
    if (texts.length > 0) return texts.join("\n");
    return JSON.stringify(r.content);
  }
  if (r.toolResult !== undefined) return JSON.stringify(r.toolResult);
  return JSON.stringify(result);
}
