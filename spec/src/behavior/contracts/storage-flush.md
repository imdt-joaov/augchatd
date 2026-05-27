---
id: contract-storage-flush
type: behavior-contract
status: proposed
capability: cap-storage
evidence:
  - source: README.md@e562b2b
    section: "Storage"
links:
  - relation: satisfies
    target: req-004-tier-stored-history
  - relation: depends_on
    target: contract-storage-hot
  - relation: depends_on
    target: contract-session-create
---

# Contract — Flush to cold storage

> [!NOTE] Implementation status (mostly shipped)
> Implemented on branch `trace-conversations` via `src/cold-storage.ts`
> (S3 client + `probeWritability` / `uploadFlush` / `downloadFlush`),
> `src/flush-scheduler.ts` (per-conversation idle timer with capped
> exponential backoff and the stalled-flush threshold), and the
> hydration helper `hydrateFromColdIfMissing` in `conversation-registry.ts`.
> Boot probe (`probeWritability`) refuses the demo boot on bad creds —
> production `POST /sessions` runs the same probe per request.
>
> The trigger model below is **idle-only** today — 5 minutes (overridable
> via `AUGCHATD_FLUSH_IDLE_MS`) of quiet since the last `upsertMessages`
> for a conversation. The "session disconnect" trigger requires the
> production session lifecycle (which is not wired); demo sessions live
> for the process lifetime, so idle is the only path that fires.
>
> **Still pending:** `noteSessionEnd` — the flush-scheduler call that
> drives the refcount-driven hot eviction (see contract-storage-hot
> §"Lifecycle") — has no caller in demo. The function exists; production
> `POST /sessions` + `DELETE /sessions/:id` minting will wire it.

## Promise

A conversation is flushed from hot SQLite to the integrator's S3-compatible bucket on either trigger:

- **Session disconnect**
- **5 minutes of inactivity**

What flushes with the conversation:

- All messages, in order.
- The conversation's **per-connector active state** (see [contract-connector-toggle](connector-toggle.md), [adr-0010](../../architecture/adrs/0010-unified-connector-model.md)) — the user's per-conversation toggle preferences survive cold-storage round-trips, so resuming the conversation in a later session restores them.

What does **not** flush:

- The session's resolved-scope connector list (URLs, auth, indexes) — that belongs to the session, not the conversation, and is gone when the session ends.

Durability is owned by a separate constraint. This contract is responsible for **triggering** flush; [`storage-durability`](../../constraints/storage-durability.md) is canonical for **what happens when a flush fails or stalls** (exponential backoff, 15-min stalled-flush threshold, read-only mode, hot-not-dropped). Don't restate the rules here.

- augchatd tests S3 at session creation; setup **fails** if it can't write (see [session-create](session-create.md)).
- On resume, if the conversation is no longer hot, augchatd **hydrates from S3**.

## Observable outcomes

- After session disconnect, a write to S3 happens; the corresponding hot row is removed only after the write returns success.
- 5 minutes of inactivity on a live session triggers a flush; subsequent activity hydrates if hot was already released.
- On resume after a successful flush + cache eviction, the conversation is loaded from S3 transparently — both messages **and** the per-connector active state. A conversation that had `rag_internal: false` saved when it flushed is hydrated with `rag_internal: false`.

Failure-mode outcomes (retry, read-only transition, recovery) are observable through this contract but are spec'd in [`storage-durability`](../../constraints/storage-durability.md).

## Non-promises

- augchatd does not client-side-encrypt before writing. Operators must configure SSE-S3/SSE-KMS on the bucket.
- augchatd does not back up across regions; that is the bucket's job.
- augchatd does not vacuum/compact cold data.

## Tests this contract implies

- Disconnect → S3 write captured.
- 5-minute idle (or test-accelerated equivalent) → flush captured.
- Hot eviction + resume → hydration from S3 visible in retrieved messages **and** in the per-connector active state returned by `GET /conversations/:cid/connectors`.

(Failure/retry/read-only tests live with [`storage-durability`](../../constraints/storage-durability.md), which owns those rules.)
