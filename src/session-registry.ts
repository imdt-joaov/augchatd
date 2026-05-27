import type { DemoModeConfig, UiTheme } from "./env.ts";
import type { Connector } from "./connectors.ts";
import { noteSessionStart } from "./flush-scheduler.ts";

/**
 * In-memory session registry. Source of truth for credentials and scope
 * (per adr-0005-jwt-signature-only — the JWT only carries the session
 * id; everything else lives here).
 */

export interface SessionRecord {
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
}

const registry = new Map<string, SessionRecord>();

export function registerSession(record: SessionRecord): void {
  registry.set(record.session_id, record);
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return registry.get(sessionId);
}

export function bindDemoSession(
  sessionId: string,
  config: DemoModeConfig,
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
  };
  registerSession(record);
  noteSessionStart(record);
  return record;
}
