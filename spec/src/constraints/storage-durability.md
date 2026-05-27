---
id: constraint-storage-durability
type: constraint
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "Storage"
links:
  - relation: supports
    target: req-004-tier-stored-history
---

# Constraint — Storage durability

> [!NOTE] Implementation status (shipped)
> Implemented on branch `trace-conversations`:
>
> - **Retry policy**: `src/flush-scheduler.ts` runs capped exponential
>   backoff (1s → 60s, default; `AUGCHATD_FLUSH_STALLED_MS` overrides
>   the stall threshold).
> - **Read-only mode**: `SessionRecord.readonly_flush_stalled` is set
>   when failures exceed the threshold. `chatHandler` returns 503 with
>   `X-Augchatd-Reason: flush-stalled`; the bundled UI's chat transport
>   detects the header and replaces the composer with the
>   "Service temporarily read-only — your messages are preserved"
>   banner (`<FlushStalledBanner />` in `ui/src/App.tsx`). Auto-recovery:
>   the next successful flush clears the flag, the next /chat returns
>   200, and the UI re-renders the composer.
> - **Hot-not-dropped**: `flush-scheduler.ts` only marks a conversation
>   `cleanlyFlushed = true` on `uploadFlush` success; eviction
>   (`closeAndRemoveHotDb`) is gated on that flag plus zero live
>   sessions for `(tenant, user)`.
>
> The rules below are now backed by code. Tests are still missing — when
> they land, this NOTE can come off and the file promotes to `current`.

## Hard rules

- **Hot is not dropped until cold has it.** A flush failure does not delete the hot copy.
- **Setup fails if S3 is not writable.** No session is ever created against a bucket augchatd cannot write to.
- **Resume hydrates from cold** if hot has been released.

## Triggers

- **Flush** on: session disconnect, **or** 5 minutes of inactivity.
- **Hydrate** on: session resume when hot copy is gone.

## Retry policy

Failed flushes retry with **exponential backoff** (initial delay 1s, doubling, capped at 60s between attempts). Retries continue in the background while the session keeps running normally.

If no flush succeeds within the **stalled-flush threshold** (default **15 minutes** from the first failed attempt of the current flush attempt sequence), the session transitions to **read-only mode**:

- `POST /chat` returns `503 Service Unavailable` with header `X-Augchatd-Reason: flush-stalled`.
- `GET /conversations*` continues to work (reads are unaffected).
- Background flush attempts continue at the capped backoff schedule.
- On the **first successful flush** after the transition, the session automatically exits read-only mode and accepts chat messages again — no client action required beyond a retry.

**Hot data is still not dropped while in read-only mode.** The durability guarantee holds: hot is released only after a successful cold write.

The threshold and backoff parameters are daemon-wide configuration; per-session tuning is out of scope for now.

## What this does **not** guarantee

- **No cross-region replication.** That is the bucket's responsibility.
- **No backup.** That is the bucket's responsibility.
- **No client-side encryption.** Operator configures SSE-S3/SSE-KMS/etc on the bucket.
- **No corruption recovery beyond standard SQLite/S3 behavior.**

## Observability

Logs go to stderr; flush failures, retries, the read-only-mode transition, and the recovery event are all logged there. Operators wire collectors as they see fit (see [observability](observability.md)).

The **read-only-mode transition** is the event most worth alerting on — it means a tenant's bucket has been unreachable for an extended period. Recovery is also logged so operators can confirm the issue resolved.
