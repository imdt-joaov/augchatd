---
id: contract-session-create
type: behavior-contract
status: proposed
capability: cap-session-mgmt
evidence:
  - source: README.md@e562b2b
    section: "README header / How it works (step 1) / Storage"
  - source: src/routes/sessions.ts
    section: "createSessionHandler (POST /sessions handler)"
  - source: src/session-registry.ts
    section: "bindSession (per-session connector ownership)"
links:
  - relation: satisfies
    target: req-001-per-user-credentials
  - relation: satisfies
    target: req-003-server-side-secrets
  - relation: depends_on
    target: technical-contract-http-post-sessions
  - relation: enables
    target: contract-session-chat
---

# Contract — Session creation

## Promise

Given a valid mTLS client cert and a JSON payload containing at minimum `user_id`, `system_prompt`, `model`, and `storage.s3`, augchatd:

1. **Validates** the payload shape (including the `user_id` / `tenant_id` alphabet — see [contract-storage-hot](storage-hot.md) §"Identifier alphabet").
2. **Tests S3 writability** against the supplied bucket and credentials. If it cannot write, the request fails with a 4xx and **no session is created**.
3. **Probes the LLM credential** by calling the provider's list-models endpoint (`GET /v1/models` for OpenAI / Anthropic) with the supplied `model.api_key`. A non-2xx response from the provider fails the request with a 4xx; **no session is created**. This catches an obviously-wrong key at session setup instead of at first chat (where it would surface as a stream-side 5xx with poor UX). Same posture as the S3 check.
4. **Stores** the credentials and the **connector registry** (the resolved scope; each entry carries `descriptive_id`, `name`, `type`, `default_active`, and type-specific config) in process memory keyed by a new `session_id`. The active flag is **not** held on the session — it lives per conversation (see [contract-connector-toggle](connector-toggle.md), [adr-0010](../../architecture/adrs/0010-unified-connector-model.md)).
5. **Mints** a JWT (signature-validated, short-lived, minutes).
6. **Returns** `{ session_id, jwt, expires_at }`.

If `connectors[]` is present, each entry is parsed by its `type` (`mcp` | `rag`), validated (required fields per type), and added to the session's connector registry. Connector credentials live in process memory for the session's lifetime. The list is optional — a session with no connectors gives a plain chat with no tools or retrieval. See [adr-0010](../../architecture/adrs/0010-unified-connector-model.md).

The integrator is the sole authority on **which** connectors a session gets (the *resolved scope*); augchatd does not decide policy, it enforces what the payload declared.

> **Demo equivalent.** In demo mode (`AUGCHATD_MODE=demo`), a file-backed analogue `POST /demo/sessions` mints sessions from a JSON config loaded once at boot from `local/demo_session.json` — same response shape `{ session_id, jwt, expires_at, theme }`, no mTLS, no per-call payload. The S3 writability check is not run today (cold flush itself is pending — see [contract-storage-flush](storage-flush.md)); the LLM credential probe IS run, at boot, and a bad key refuses the boot with a single-line error. The on-disk JSON mirrors this contract's request shape so the iframe + postMessage handshake exercised in demo is the same flow integrators use in production. See [contract-demo-mode](demo-mode.md).

## Observable outcomes

- A 2xx response on success carrying the three fields.
- A 4xx on a setup that cannot reach S3 — no session exists in memory afterwards.
- A 4xx (or refuse-to-boot in demo) when the LLM-credential probe fails — provider 401 / network error / unknown provider. No session is created.
- A 4xx on missing required fields (`user_id`, `system_prompt`, `model`, `storage.s3`).
- A 4xx on a malformed connector entry: unknown `type`, missing required per-type fields, duplicate `descriptive_id` within the same session, or — for `type: "rag"` — `backend` other than `"opensearch"` (pgvector is not accepted today; see [pressure-pgvector-backend](../../pressure/pgvector-backend.md)).
- A successful response after which the same `session_id` is unknown to a second augchatd process (sessions are per-process).

## Non-promises

- augchatd does not validate that the LLM key works (provider call only happens at chat time).
- augchatd does not validate that a connector's upstream is reachable (failure surfaces during chat).
- augchatd does not enforce that `user_id` is unique across sessions — concurrent sessions for the same user are allowed.
- augchatd does not deduplicate connectors across sessions; each session carries its own `connectors[]`.

## Tests this contract implies

- mTLS challenge-response with a valid cert succeeds.
- mTLS without a cert or with an untrusted cert is rejected.
- S3 unreachable → 4xx, no session created.
- Minimal payload (just `model + storage`) creates a working session.
- Payload with `connectors[]` of mixed types (`mcp` + `rag`) creates a session that exposes the active subset at chat time.
- Payload with a duplicate `descriptive_id` in `connectors[]` → 4xx, no session created.
- Payload with an unknown `type` → 4xx, no session created.
- Payload with a RAG connector whose `backend` is `"pgvector"` (or any non-`"opensearch"` value) → 4xx, no session created.
- Payload with a connector missing a per-type required field (e.g. `mcp` without `url`, `rag` without `indexes`) → 4xx, no session created.
