import type { DemoModeConfig, UiTheme } from "./env.ts";
import type { Connector } from "./connectors.ts";
import type { ConnectedMcp } from "./mcp.ts";
import type { ConnectedRag, RagHit } from "./rag.ts";
import { noteSessionStart } from "./flush-scheduler.ts";

/**
 * In-memory session registry. Source of truth for credentials and scope
 * (per adr-0005-jwt-signature-only — the JWT only carries the session
 * id; everything else lives here).
 */

/**
 * Per-session connector client storage. The session OWNS its MCP/RAG
 * client handles; chat-time dispatch reads from here, and DELETE
 * /sessions/:id calls `closeMcpClients(mcpClients)` to release them.
 *
 * In demo, the Maps are passed by reference from a boot-initialized
 * shared pair (single user, no isolation boundary) so the connector
 * handshakes only happen once per process. In prod (POST /sessions),
 * each session creates its own Maps and runs initMcpConnectors /
 * initRagConnectors against them — credentials never cross session
 * boundaries.
 */
export interface SessionConnectorState {
  mcpClients: Map<string, ConnectedMcp>;
  ragClients: Map<string, ConnectedRag>;
  ragHitsByToolCall: Map<string, RagHit[]>;
}

export interface SessionRecord extends SessionConnectorState {
  session_id: string;
  /**
   * Tenant the session belongs to (per constraint-tenant-isolation +
   * contract-storage-hot's `data/<tenantId>/<userId>.sqlite` layout).
   * In demo mode: `"demo"`.
   */
  tenant_id: string;
  user_id: string;
  system_prompt: string;
  model: {
    provider: string;
    model_id: string;
    api_key: string;
  };
  /**
   * Cold-storage config from the session payload. Opaque until
   * contract-storage-flush parses it; today the boot log just notes
   * whether it was supplied (configured vs hot-only).
   */
  storage: Record<string, unknown> | undefined;
  /** Typed connectors[]; empty if the session didn't declare any. */
  connectors: Connector[];
  /** UI color scheme the bundled UI should render with. */
  theme: UiTheme;
  /**
   * Per-session read-only flag (contract-storage-durability). Set by
   * the flush scheduler when a conversation flush has stalled beyond
   * the threshold; cleared on the next successful flush. While true,
   * `POST /chat` returns 503 with `X-Augchatd-Reason: flush-stalled`.
   * Mutable: the flush scheduler updates this in place.
   */
  readonly_flush_stalled: boolean;
  /**
   * Session-wide abort signal. The chat handler merges this with the
   * per-request signal so a forced DELETE /sessions/:id can interrupt
   * the in-flight LLM stream + tool calls immediately (per the user's
   * choice: abort, not wait — see contract-session-delete).
   */
  abortController: AbortController;
}

const registry = new Map<string, SessionRecord>();

export function registerSession(record: SessionRecord): void {
  registry.set(record.session_id, record);
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return registry.get(sessionId);
}

/**
 * Remove the session from the registry. Returns the record if it was
 * present (caller is responsible for closing its connector clients +
 * any final flush). Idempotent.
 */
export function unregisterSession(sessionId: string): SessionRecord | undefined {
  const r = registry.get(sessionId);
  if (r) registry.delete(sessionId);
  return r;
}

export function bindDemoSession(
  sessionId: string,
  config: DemoModeConfig,
  shared: SessionConnectorState,
): SessionRecord {
  const record: SessionRecord = {
    session_id: sessionId,
    // Tenant is hardcoded in demo per contract-demo-mode: single-tenant by
    // design. user_id flows through from the session payload so the hot
    // SQLite lands at data/demo/<user_id>.sqlite.
    tenant_id: "demo",
    user_id: config.user_id,
    system_prompt: config.system_prompt,
    model: config.model,
    storage: config.storage,
    connectors: config.connectors,
    theme: config.theme,
    readonly_flush_stalled: false,
    // Demo shares the boot-initialized MCP/RAG clients across every
    // mint of /demo/sessions (single-tenant by design). ragHitsByToolCall
    // is also shared: collisions are astronomically unlikely (random
    // UUIDs), and demo is not a security boundary.
    mcpClients: shared.mcpClients,
    ragClients: shared.ragClients,
    ragHitsByToolCall: shared.ragHitsByToolCall,
    abortController: new AbortController(),
  };
  registerSession(record);
  noteSessionStart(record);
  return record;
}

/**
 * Build a SessionRecord for a production `POST /sessions` call. Unlike
 * `bindDemoSession`, this allocates fresh per-session Maps for the
 * connector clients — the caller (`createSessionHandler`) populates them
 * via `initMcpConnectors` / `initRagConnectors` before returning, so
 * credentials live only within this SessionRecord and never appear in
 * any module-level storage.
 */
export function bindSession(input: {
  sessionId: string;
  tenantId: string;
  userId: string;
  systemPrompt: string;
  model: { provider: string; model_id: string; api_key: string };
  storage: Record<string, unknown> | undefined;
  connectors: Connector[];
  theme: UiTheme;
}): SessionRecord {
  const record: SessionRecord = {
    session_id: input.sessionId,
    tenant_id: input.tenantId,
    user_id: input.userId,
    system_prompt: input.systemPrompt,
    model: input.model,
    storage: input.storage,
    connectors: input.connectors,
    theme: input.theme,
    readonly_flush_stalled: false,
    mcpClients: new Map(),
    ragClients: new Map(),
    ragHitsByToolCall: new Map(),
    abortController: new AbortController(),
  };
  registerSession(record);
  noteSessionStart(record);
  return record;
}
