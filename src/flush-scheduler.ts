import { storageFor, openHotDb } from "./storage.ts";
import {
  coldStorageConfigFrom,
  uploadFlush,
  type ColdStorageConfig,
  type FlushedConversation,
} from "./cold-storage.ts";
import type { SessionRecord } from "./session-registry.ts";
import { writeTraceEvent } from "./trace.ts";

/**
 * Cold-storage flush scheduler. One idle timer per conversation; resets
 * on every `noteConversationActivity` call from the chat handler. After
 * `FLUSH_IDLE_MS` of quiet, the conversation is serialized from hot
 * SQLite and uploaded to the session's `storage.s3` bucket.
 *
 * Failure path: exponential backoff (capped). After `STALLED_THRESHOLD_MS`
 * of consecutive failure the **session** transitions to read-only — the
 * chat handler observes `session.readonly_flush_stalled` and returns
 * 503 with `X-Augchatd-Reason: flush-stalled` (contract-session-chat,
 * contract-storage-durability). The next successful flush clears the
 * flag.
 *
 * After a successful flush, the hot rows for that cid are NOT dropped —
 * the lifecycle rule from contract-storage-hot says hot stays alive
 * while any session for the user is alive. Hot eviction happens via
 * `noteSessionEnd` below: when the last session for a (tenant, user)
 * ends and all that user's conversations have been flushed, the SQLite
 * file is closed and removed.
 *
 * Demo mode keeps one (tenant=demo, user=<user_id>) session alive for
 * the process lifetime, so eviction does not fire — the demo's
 * persistent hot file is exactly what `contract-demo-mode` describes.
 */

// Time constants — overridable via env for tests / demos.
const FLUSH_IDLE_MS = Number(
  process.env.AUGCHATD_FLUSH_IDLE_MS ?? 5 * 60 * 1000,
);
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const STALLED_THRESHOLD_MS = Number(
  process.env.AUGCHATD_FLUSH_STALLED_MS ?? 15 * 60 * 1000,
);

interface ConversationFlushState {
  cid: string;
  // (tenant, user) is what scopes the hot file + the cold key.
  tenant: string;
  user: string;
  // Session whose `storage.s3` creds we use for this conversation's
  // flush. If the session is replaced (re-mint), this is rebound on
  // the next `noteConversationActivity`.
  session: SessionRecord;
  idleTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  // Wall-clock when the current failure streak started; cleared on
  // success. Used to compute against STALLED_THRESHOLD_MS.
  failingSince: number | null;
  attemptNumber: number;
  // True between dispatch and either success or failure recording. A
  // second activity event during a flush re-arms the idle timer but
  // does not interrupt the in-flight upload.
  inFlight: boolean;
  // True once we've successfully flushed everything we know about; the
  // hot-eviction check uses this.
  cleanlyFlushed: boolean;
}

const states = new Map<string, ConversationFlushState>();

// Per-(tenant, user) refcount of live sessions. A session is live from
// `noteSessionStart` (in session-registry.bindDemoSession / future
// POST /sessions) until `noteSessionEnd` (forced delete, JWT expiry GC,
// process restart). Hot eviction triggers when the count drops to 0
// AND every conversation for that user has `cleanlyFlushed === true`.
const sessionRefcounts = new Map<string, number>();

function userKey(tenant: string, user: string): string {
  return `${tenant}/${user}`;
}

/**
 * The chat handler calls this every time it persists a turn. Resets
 * the idle timer (also rebinds the session so a re-minted session's
 * fresh `storage.s3` creds are used on the next flush).
 */
export function noteConversationActivity(cid: string, session: SessionRecord): void {
  // If cold storage isn't configured for this session, there's nothing
  // to schedule — hot-only mode. The conversation just lives in hot
  // until process exit (or eviction once that's wired with refcount).
  let cold: ColdStorageConfig | undefined;
  try {
    cold = coldStorageConfigFrom(session.storage);
  } catch (err) {
    // Malformed storage block at this layer means the session validator
    // missed it. Surface via stderr but do not crash the chat turn.
    console.error(
      `flush: bad storage config on session ${session.session_id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!cold) return;

  const existing = states.get(cid);
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.session = session;
    existing.cleanlyFlushed = false;
    existing.idleTimer = setTimeout(() => attemptFlush(cid), FLUSH_IDLE_MS);
    return;
  }
  const state: ConversationFlushState = {
    cid,
    tenant: session.tenant_id,
    user: session.user_id,
    session,
    idleTimer: setTimeout(() => attemptFlush(cid), FLUSH_IDLE_MS),
    retryTimer: null,
    failingSince: null,
    attemptNumber: 0,
    inFlight: false,
    cleanlyFlushed: false,
  };
  states.set(cid, state);
}

/** Reference-count tracking — call when a session record is registered. */
export function noteSessionStart(session: SessionRecord): void {
  const k = userKey(session.tenant_id, session.user_id);
  sessionRefcounts.set(k, (sessionRefcounts.get(k) ?? 0) + 1);
}

/**
 * Reference-count tracking — call when a session is removed (forced
 * logout, JWT-expiry GC). When the refcount drops to 0 AND every
 * conversation for the (tenant, user) is `cleanlyFlushed`, the hot DB
 * is closed and the file is deleted. If any conversation has not
 * flushed yet, eviction defers until the last in-flight flush
 * completes (the success path checks the refcount).
 */
export function noteSessionEnd(session: SessionRecord): void {
  const k = userKey(session.tenant_id, session.user_id);
  const n = (sessionRefcounts.get(k) ?? 1) - 1;
  if (n <= 0) {
    sessionRefcounts.delete(k);
    maybeEvict(session.tenant_id, session.user_id);
  } else {
    sessionRefcounts.set(k, n);
  }
}

function isUserActive(tenant: string, user: string): boolean {
  return (sessionRefcounts.get(userKey(tenant, user)) ?? 0) > 0;
}

async function attemptFlush(cid: string): Promise<void> {
  const state = states.get(cid);
  if (!state) return;
  state.idleTimer = null;
  state.inFlight = true;

  let cold: ColdStorageConfig | undefined;
  try {
    cold = coldStorageConfigFrom(state.session.storage);
  } catch {
    cold = undefined;
  }
  if (!cold) {
    state.inFlight = false;
    return; // cold became absent (shouldn't happen) — bail without retry
  }

  const body = serializeConversation(cid, state.session);
  try {
    await uploadFlush(cold, state.tenant, state.user, cid, body);
    onFlushSuccess(state);
  } catch (err) {
    onFlushFailure(state, err);
  }
}

function serializeConversation(cid: string, session: SessionRecord): FlushedConversation {
  const db = storageFor(session);
  const conv = db
    .prepare("SELECT model_id_override FROM conversation WHERE conversation_id = ?")
    .get(cid) as { model_id_override: string | null } | undefined;

  const messages = (
    db
      .prepare(
        `SELECT message_id, ordinal, role, parts_json, metadata_json
           FROM message
          WHERE conversation_id = ?
          ORDER BY ordinal ASC, message_id ASC`,
      )
      .all(cid) as Array<{
      message_id: string;
      ordinal: number;
      role: string;
      parts_json: string;
      metadata_json: string | null;
    }>
  ).map((r) => ({
    id: r.message_id,
    ordinal: r.ordinal,
    role: r.role,
    parts: safeParse(r.parts_json, []),
    metadata: r.metadata_json ? safeParse(r.metadata_json, null) : null,
  }));

  const connector_state = (
    db
      .prepare(
        `SELECT descriptive_id, active
           FROM connector_state
          WHERE conversation_id = ?`,
      )
      .all(cid) as Array<{ descriptive_id: string; active: number }>
  ).map((r) => ({ descriptive_id: r.descriptive_id, active: r.active === 1 }));

  return {
    schema_version: 1,
    messages,
    connector_state,
    model_id_override: conv?.model_id_override ?? null,
    flushed_at: new Date().toISOString(),
  };
}

function safeParse<T>(s: string, fallback: T): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function onFlushSuccess(state: ConversationFlushState): void {
  state.inFlight = false;
  state.failingSince = null;
  state.attemptNumber = 0;
  state.cleanlyFlushed = true;
  // Clear session read-only on success — durability is restored.
  state.session.readonly_flush_stalled = false;

  writeTraceEvent(state.cid, {
    type: "flush.success",
    conversation_id: state.cid,
    session_id: state.session.session_id,
  });

  // If the user has no live sessions, this success may unblock hot
  // eviction.
  if (!isUserActive(state.tenant, state.user)) {
    maybeEvict(state.tenant, state.user);
  }
}

function onFlushFailure(state: ConversationFlushState, err: unknown): void {
  state.inFlight = false;
  const now = Date.now();
  if (state.failingSince === null) state.failingSince = now;
  state.attemptNumber++;

  const message = err instanceof Error ? err.message : String(err);
  writeTraceEvent(state.cid, {
    type: "flush.error",
    conversation_id: state.cid,
    session_id: state.session.session_id,
    attempt: state.attemptNumber,
    message,
  });

  // Stall check — if we've been failing for too long, mark the session
  // read-only. POST /chat will start returning 503; the flag clears on
  // the next success.
  const failedFor = now - state.failingSince;
  if (failedFor >= STALLED_THRESHOLD_MS && !state.session.readonly_flush_stalled) {
    state.session.readonly_flush_stalled = true;
    writeTraceEvent(state.cid, {
      type: "flush.stalled",
      conversation_id: state.cid,
      session_id: state.session.session_id,
      failing_for_ms: failedFor,
    });
  }

  // Schedule next retry with capped exponential backoff.
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_INITIAL_MS * 2 ** (state.attemptNumber - 1),
  );
  state.retryTimer = setTimeout(() => attemptFlush(state.cid), delay);
}

/**
 * Hot eviction: close the SQLite file and remove the on-disk artifact
 * once (a) no session for the (tenant, user) is live and (b) every
 * conversation for that user has flushed successfully.
 *
 * The actual file removal is delegated to `storage.ts` so the per-file
 * mutex / open-handle map stays in one place. Until we wire that
 * fully, we mark the state cleanly-evictable and emit a trace event
 * for operability — the operator can then `rm` the file if they need
 * to reclaim disk.
 */
function maybeEvict(tenant: string, user: string): void {
  // Every conversation belonging to (tenant, user) must be flushed.
  for (const s of states.values()) {
    if (s.tenant !== tenant || s.user !== user) continue;
    if (!s.cleanlyFlushed) return;
  }
  // Best-effort: close+delete the DB file. The next request that
  // resolves to this (tenant, user) will reopen it from scratch.
  try {
    closeAndRemoveHotDb(tenant, user);
  } catch (err) {
    console.error(
      `flush: hot eviction failed for ${tenant}/${user}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Side-effect import to keep the helper findable from this module
// without re-exposing the entire storage surface.
import { closeAndRemoveHotDb } from "./storage.ts";
// `openHotDb` is imported above so the lazy reopen path is reachable
// after eviction.
void openHotDb;
