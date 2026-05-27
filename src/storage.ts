import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionRecord } from "./session-registry.ts";

/**
 * Hot storage — embedded SQLite per (tenant, user).
 *
 * Per contract-storage-hot:
 *   data/<tenantId>/<userId>.sqlite — one file per (tenant, user) pair.
 *
 * What's implemented here (this slice):
 *   - per-conversation connector active_map  ← canonical, backs the toggle
 *   - per-conversation model_id_override
 *   - per-conversation messages history (UIMessage parts JSON)
 *
 * Still pending (documented in spec PENDING blocks, not silently absent):
 *   - flush-to-S3 cold storage (contract-storage-flush)
 *   - multi-session file lifecycle (file removal when all sessions for a
 *     (tenant, user) end + the user's data has flushed)
 *   - production routing (lazy-open per session). Demo opens one DB at
 *     boot and reuses it for the process lifetime.
 *   - UI-side hydration on page reload (GET /conversations/:cid/messages
 *     exists; the bundled UI doesn't consume it yet).
 *
 * The error model matches contract-storage-hot: write failures throw
 * HotWriteError and the chat / connectors / model handlers surface them
 * as 503 with `X-Augchatd-Reason: hot-write-failed`.
 */

const DATA_DIR = process.env.AUGCHATD_DATA_DIR ?? "data";

export class HotWriteError extends Error {
  constructor(public detail: string) {
    super(`hot-write-failed: ${detail}`);
  }
}

/**
 * One open DB per (tenant, user) for the process lifetime. Demo mode
 * has exactly one entry. The map keying is `${tenant_id}/${user_id}`.
 */
const opened = new Map<string, Database>();

function dbKey(tenant_id: string, user_id: string): string {
  return `${tenant_id}/${user_id}`;
}

function dbPathFor(tenant_id: string, user_id: string): string {
  return join(DATA_DIR, sanitize(tenant_id), `${sanitize(user_id)}.sqlite`);
}

// Path components are derived from session-bound identifiers (in demo:
// "demo" / "demo"). Sanitize defensively against malicious values when
// prod session minting lands.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "_";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation (
  conversation_id    TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  model_id_override  TEXT,
  reasoning_disabled INTEGER,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_state (
  conversation_id  TEXT NOT NULL,
  descriptive_id   TEXT NOT NULL,
  active           INTEGER NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, descriptive_id)
);

CREATE TABLE IF NOT EXISTS message (
  conversation_id  TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  role             TEXT NOT NULL,
  parts_json       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE INDEX IF NOT EXISTS message_by_conversation
  ON message (conversation_id, ordinal);
`;

/** Open (or reuse) the hot DB for a (tenant, user). */
export function openHotDb(tenant_id: string, user_id: string): Database {
  const key = dbKey(tenant_id, user_id);
  const cached = opened.get(key);
  if (cached) return cached;

  const path = dbPathFor(tenant_id, user_id);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw new HotWriteError(
      `mkdir ${dirname(path)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(SCHEMA);
    // Forward-only migrations for tables that pre-existed without a
    // newer column. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we
    // try and swallow the "duplicate column" error on already-migrated
    // databases. New columns must keep being added here when the
    // schema grows.
    for (const stmt of MIGRATIONS) {
      try {
        db.exec(stmt);
      } catch {
        /* column already exists — idempotent */
      }
    }
    opened.set(key, db);
    return db;
  } catch (err) {
    throw new HotWriteError(
      `open ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const MIGRATIONS = [
  // Per-message metadata (e.g. which model produced an assistant message).
  // Added after the initial schema; existing rows get NULL.
  "ALTER TABLE message ADD COLUMN metadata_json TEXT",
  // Per-conversation reasoning toggle (contract-reasoning-toggle). We
  // store the "disabled" flag so NULL/0 = enabled (preserves the
  // pre-migration default) and no backfill is needed.
  "ALTER TABLE conversation ADD COLUMN reasoning_disabled INTEGER",
];

/** Get (or open) the hot DB for a session. */
export function storageFor(session: SessionRecord): Database {
  return openHotDb(session.tenant_id, session.user_id);
}

/** Open the demo (tenant, user) DB at boot so the first write is fast. */
export function initStorageForDemo(user_id: string): void {
  openHotDb("demo", user_id);
}

/**
 * Close and delete the hot SQLite file for one (tenant, user) — the
 * eviction half of contract-storage-hot's "file lives while any session
 * is alive" rule. The flush scheduler calls this once it has confirmed
 * the user has no live sessions AND every conversation has flushed
 * successfully to cold. A request that arrives after eviction will
 * reopen the file (empty schema; cold hydration on first
 * `getConversation`).
 *
 * Best-effort: a failure to unlink (e.g. concurrent reader) is logged
 * and the in-memory entry is still removed — the file may stay on
 * disk and be reopened later, which is correct under the durability
 * model (cold has the data; hot is a cache).
 */
export function closeAndRemoveHotDb(tenant_id: string, user_id: string): void {
  const key = dbKey(tenant_id, user_id);
  const db = opened.get(key);
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    opened.delete(key);
  }
  const path = dbPathFor(tenant_id, user_id);
  try {
    rmSync(path, { force: true });
    // Also remove the WAL sidecar files SQLite creates under WAL mode.
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  } catch (err) {
    console.error(
      `storage: failed to remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

