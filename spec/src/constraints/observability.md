---
id: constraint-observability
type: constraint
status: proposed
evidence:
  - source: README.md@e562b2b
    section: "What augchatd does NOT do (observability)"
---

# Constraint — Observability

## What augchatd ships

- **Logs to stderr** for runtime errors and warnings (`HotWriteError`, connector failures, trace-write failures). The operator wires their own collector (Loki, CloudWatch, Datadog, etc.).
- **Boot banner and connector-status lines go to stdout** (`augchatd up on :8080 …`; `mcp[…] connected, tools: …`; `rag[…] connected (opensearch), indexes: …`). These are foreground operator signals during startup, not error conditions; stdout keeps them out of any stderr-only collector wired by the operator.
- Sanitized log lines — connector credentials (`auth.*`) and internal upstream URLs do not appear.
- **Optional per-conversation JSONL trace.** Enabled by setting `AUGCHATD_TRACE_DIR=/path/to/dir`. When set, each `POST /chat` appends a per-conversation JSONL file (`${conversation_id}.jsonl`) with one event per line: `request`, `step.finish`, `response.finish`, `error`. Off by default; zero filesystem cost when unset (empty string `AUGCHATD_TRACE_DIR=""` is treated as unset). Mode-agnostic. The directory is created at boot; an unwritable path is a refuse-to-start (boot exits 1 with a single-line error — same posture as the demo-session-config validator). The conversation_id file segment is sanitized to `[a-zA-Z0-9._-]` and truncated to 200 chars; server-minted UUIDs pass through unchanged, so collisions only occur if a hostile integrator chose a colliding id (out of scope today). This is a **debug-time conversation dump for the operator** — local files, not OTel, not a tamper-evident audit log; replay-grade rather than compliance-grade.

### Trace event guarantees

- **Event types:** `request` (start of a `POST /chat`), `step.finish` (one per tool-use loop step), `response.finish` (the model produced a final answer), `aborted` (the client closed the connection before the stream finished — distinct from `error` so trace consumers can tell "user closed the tab" from "provider exploded"; carries the abort reason in `message` and no `stack`), `error` (anything else thrown inside the chat handler — carries `message` + `stack`), `connector.toggle.deferred` (a `PUT /conversations/:cid/connectors/:did` arrived while a chat turn was streaming for the same `cid` — the write landed but the in-flight turn's active-map snapshot is unchanged; see [contract-connector-toggle](../behavior/contracts/connector-toggle.md) §"Toggle audit"), `upstream.unauthorized` (an MCP tool call returned 401 from the upstream connector — the connector's auth has expired or was revoked; carries `connector`, `tool_call_id`, `tool_name`; see [contract-jwt-refresh](../behavior/contracts/jwt-refresh.md) PENDING block), `flush.success` (the idle-triggered cold flush wrote the conversation to S3), `flush.error` (a flush attempt failed — carries `attempt` and `message`; the scheduler retries with capped exponential backoff), `flush.stalled` (consecutive failures crossed `AUGCHATD_FLUSH_STALLED_MS`; the session went read-only — carries `failing_for_ms`; see [storage-durability](storage-durability.md)).
- **Minimum fields per line:** `ts` (ISO 8601), `type`, `conversation_id`, `session_id`.
- **Order:** `request` lands before any other event for the same chat call; `step.finish` events arrive in step order; `response.finish` is last on the happy path. `error` can land between any two events.
- **Append model:** synchronous `appendFileSync` per event — ordering is deterministic, no buffering. A process crash before the kernel flushes the page cache may drop the last write, but never reorders earlier ones.
- **Redaction scope (canonical):**
  - `model.api_key` is never serialized.
  - Connector `auth.*` payloads (bearer / basic / headers) are never serialized — the `request` event lists only `descriptive_id`, `type`, `name`, `default_active`, `active`.
  - **NOT redacted, by design:** `system_prompt`, the full `messages[]` history, tool call arguments, tool results, RAG hit content, and provider error stack traces. The trace is replay-grade — anyone with access to the file already has access to the upstream calls anyway. Operators who treat trace files as sensitive should restrict the host filesystem accordingly.

## What augchatd does **not** ship

- Dashboards
- Metrics endpoints / Prometheus scrape targets
- Distributed tracing instrumentation
- Built-in audit log

These are deliberately out of scope. Integrators that need them wire their own collectors or run augchatd behind a proxy that emits them.

> [!NOTE] Assumption
> The README states "Logs go to stderr; wire your own collector" but does not specify a log format. Until code lands, the format is an evidence gap. Default expectation: structured (JSON) lines, but unconfirmed.
