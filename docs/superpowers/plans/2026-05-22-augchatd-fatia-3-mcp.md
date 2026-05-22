# augchatd — Fatia 3 (MCP client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate MCP in augchatd. `POST /sessions` (and the demo boot path) accept an optional `mcp_servers` list; the daemon eager-initializes each server (HTTP/SSE), caches its tools, and feeds them into the Vercel AI SDK tool-use loop. Tool calls run with bounded concurrency, per-call and per-turn timeouts, cancellation propagation, MCP 401 → session-stale, and full sanitization of operator topology metadata (URLs, headers, request IDs). All the dead code paths reserved since Fatia 1 (`SessionEntry.stale`, 401 `mcp_credentials_expired`, `tool_calls` column, `auth-required.reason='mcp_credentials_expired'`) gain real origins.

**Architecture:** Same Bun + Hono process. A new `src/mcp/` module owns: a JSON-RPC client (built on `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`/`SSEClientTransport`) wrapped in our own `McpClient` interface (interface + real impl + fake — same pattern Fatia 2 uses for S3); a tool translator that converts MCP `tools/list` JSON Schemas to AI SDK `tool({})` definitions; an eager-init coordinator that runs `initialize` + `tools/list` against every server and returns either a populated `Map<label, McpClientHandle>` or a categorized error; and a sanitization helper that strips URL/headers/request-id keys recursively from stream events. The chat module's `streamText` call now receives `tools` (label-prefixed names → AI SDK tool defs with `execute()` that calls MCP through the handle), `maxSteps: 10`, two `AbortController`s (per-tool 30s and total turn 5min), and an `onStepFinish` that persists assistant rows with `tool_calls` JSON plus separate `role='tool'` rows for results. The data stream is piped through a `TransformStream` that runs `sanitizeChunk` before bytes leave the process. MCP 401 anywhere in a turn throws `McpUnauthorizedError`, caught by the error handler which calls `markStale(sid)`, emits `3: error mcp_credentials_expired`, and closes the stream. Demo mode and prod use the same eager-init code path; demo failure = `exit 1`, prod failure = `400`.

**Tech Stack:** Bun ≥ 1.1 (unchanged) · Hono 4 (unchanged) · Vercel AI SDK 4 (`ai`, `@ai-sdk/anthropic`) — already on board · `@modelcontextprotocol/sdk` ^1.0.0 (new dependency) · `zod` for tool schema parsing of MCP `tools/list` payloads.

**Source of truth for decisions:** `docs/superpowers/specs/2026-05-22-augchatd-fatia-3-mcp-spec.md` (this fatia), `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md` (transversal). Tasks reference spec sections (§N.M) and cluster letters (A–I).

**Pre-requisite:** Fatia 2 implemented and merged (plan: `docs/superpowers/plans/2026-05-22-augchatd-fatia-2-producao.md`). This plan extends that codebase. SessionEntry, S3 client, flush queue, and graceful shutdown are all already present.

---

## File Structure

New files (created by this plan):

```
src/
├── config/
│   ├── env.ts                       # MODIFIED: add MCP_TOOL_TIMEOUT, TURN_TIMEOUT, MCP_PARALLEL_CAP
│   ├── session-schema.ts            # MODIFIED: add McpAuthSchema, McpServerSchema, mcp_servers field
│   └── demo.ts                      # MODIFIED: parse DEMO_MCP_SERVERS as JSON
├── auth/
│   └── sessions.ts                  # MODIFIED: SessionEntry gains mcpClients; onEvict closes them
├── mcp/                             # NEW DIR
│   ├── types.ts                     # NEW: McpClientHandle, McpToolDef, McpError, McpUnauthorizedError
│   ├── client.ts                    # NEW: McpClient interface + SdkMcpClient (real) + FakeMcpClient
│   ├── tools.ts                     # NEW: translate tools/list result to AI SDK tool defs
│   ├── eager-init.ts                # NEW: connect/init/list per server; returns handles or categorized error
│   ├── sanitize.ts                  # NEW: strip url/headers/request_id recursively from any object
│   └── pool.ts                      # NEW: bounded concurrency Promise pool for parallel tool execution
├── chat/
│   ├── stream.ts                    # MODIFIED: streamText with tools, maxSteps, sanitization pipe, error handling
│   └── hydrate.ts                   # NEW: SQLite rows → AI SDK ModelMessage[] (handles tool_calls/tool rows)
├── storage/
│   ├── messages.ts                  # MODIFIED: appendMessage carries tool_calls; insertToolResult helper
│   └── hydration.ts                 # MODIFIED: invoke new src/chat/hydrate for cold→hot reconstruction
├── server/
│   └── routes/
│       └── sessions.ts              # MODIFIED: after S3 smoke test, eager MCP init; DELETE closes MCP clients
└── index.ts                         # MODIFIED: demo boot now runs eager MCP init; exit 1 on failure

tests/
├── mcp/
│   ├── client.test.ts               # NEW: fake client semantics
│   ├── tools.test.ts                # NEW: MCP tools/list → AI SDK tool() defs
│   ├── eager-init.test.ts           # NEW: success path + each error category
│   ├── sanitize.test.ts             # NEW: keys stripped recursively, values preserved
│   └── pool.test.ts                 # NEW: concurrency cap, cancellation
├── chat/
│   ├── stream.test.ts               # MODIFIED: add tool-use scenarios, 401 mid-stream, loop limit, timeout, cancellation
│   └── hydrate.test.ts              # NEW: rows → ModelMessage[] including tool_use/tool_result parts
├── storage/
│   └── messages.test.ts             # MODIFIED: tool_calls + insertToolResult coverage
├── server/
│   └── routes/
│       └── sessions.test.ts         # MODIFIED: success with mcp_servers; each MCP failure category
└── e2e/
    └── mcp.test.ts                  # NEW: end-to-end with FakeMcpClient through demo and prod paths
```

---

## Conventions

Inherit all from Fatias 1 and 2 plans. Adds:

- **All MCP access goes through `src/mcp/client.ts`'s `McpClient` interface.** Tests use the in-memory fake; production wires `SdkMcpClient`. Never import `@modelcontextprotocol/sdk` directly outside `src/mcp/client.ts`.
- **Sanitization is the only path out of the data stream.** No `result.toDataStreamResponse()` direct return; always wrap via `toDataStream()` → sanitizing `TransformStream` → `Response`.
- **MCP 401 is signaled by throwing `McpUnauthorizedError`**, not by returning a tool result with `status: 'error'`. This is what bubbles up to the chat-level handler that marks the session stale and emits `3: error mcp_credentials_expired`.
- **Error codes never leak upstream message bodies.** Categorized kinds only (`unreachable | credentials_expired | timeout | 5xx | invalid_response | invalid_tools_schema | protocol_error`). The raw upstream body is logged at `debug` level only, with `server_label` and never URL/headers.
- **Time injection** (from Fatia 2) extends to MCP: per-tool timeout and turn timeout both take an injectable clock for tests.
- **Spec references** use `§4.4` for the new spec; `§A.4` for the arch doc; both win over any contradicting Fatia 1/2 detail.

---

### Task 1: Env vars — add MCP_TOOL_TIMEOUT, TURN_TIMEOUT, MCP_PARALLEL_CAP

**Files:**
- Modify: `src/config/env.ts`
- Modify: `tests/config/env.test.ts`

Per spec §4.1.1.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/config/env.test.ts`:

```typescript
test('AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS defaults to 30', () => {
  const cfg = parseEnv(baseProdEnv);
  expect(cfg.mcp.toolTimeoutSeconds).toBe(30);
});

test('AUGCHATD_TURN_TIMEOUT_SECONDS defaults to 300', () => {
  const cfg = parseEnv(baseProdEnv);
  expect(cfg.mcp.turnTimeoutSeconds).toBe(300);
});

test('AUGCHATD_MCP_PARALLEL_CAP defaults to 8', () => {
  const cfg = parseEnv(baseProdEnv);
  expect(cfg.mcp.parallelCap).toBe(8);
});

test('AUGCHATD_MCP_PARALLEL_CAP coerces and rejects zero/negative', () => {
  const cfg = parseEnv({ ...baseProdEnv, AUGCHATD_MCP_PARALLEL_CAP: '16' });
  expect(cfg.mcp.parallelCap).toBe(16);
  expect(() => parseEnv({ ...baseProdEnv, AUGCHATD_MCP_PARALLEL_CAP: '0' })).toThrow();
  expect(() => parseEnv({ ...baseProdEnv, AUGCHATD_MCP_PARALLEL_CAP: '-1' })).toThrow();
});

test('non-integer timeout rejected', () => {
  expect(() =>
    parseEnv({ ...baseProdEnv, AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS: 'abc' }),
  ).toThrow();
});
```

Assume `baseProdEnv` already exists in the test file from Fatia 2's test suite. If the existing test file uses a different name (e.g. `baseDemoEnv`), use that — the tests only care about valid defaults plus the new keys.

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/env.test.ts`
Expected: FAIL — `cfg.mcp` is undefined.

- [ ] **Step 3: Extend EnvSchema and ProcessConfig**

Modify `/home/joao/augchatd/src/config/env.ts`. Add to `EnvSchema` (alongside the existing fields):

```typescript
  AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  AUGCHATD_TURN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  AUGCHATD_MCP_PARALLEL_CAP: z.coerce.number().int().positive().default(8),
```

Add to the `ProcessConfig` interface:

```typescript
  mcp: {
    toolTimeoutSeconds: number;
    turnTimeoutSeconds: number;
    parallelCap: number;
  };
```

Add to the `parseEnv` return object:

```typescript
  mcp: {
    toolTimeoutSeconds: parsed.AUGCHATD_MCP_TOOL_TIMEOUT_SECONDS,
    turnTimeoutSeconds: parsed.AUGCHATD_TURN_TIMEOUT_SECONDS,
    parallelCap: parsed.AUGCHATD_MCP_PARALLEL_CAP,
  },
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/env.test.ts`
Expected: all passing (existing tests + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts
git commit -m "feat(config): add MCP_TOOL_TIMEOUT, TURN_TIMEOUT, MCP_PARALLEL_CAP env vars"
```

---

### Task 2: SessionPayloadSchema — add McpServerSchema, mcp_servers field

**Files:**
- Modify: `src/config/session-schema.ts`
- Modify: `tests/config/session-schema.test.ts`

Per spec §4.4.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/config/session-schema.test.ts`:

```typescript
const validProdBody = {
  user_id: 'u1',
  model: { provider: 'anthropic', model_id: 'cl', api_key: 'k' },
  storage: {
    s3: { bucket: 'b', region: 'us-east-1', access_key_id: 'A', secret_access_key: 'S' },
  },
};

test('mcp_servers is optional and absence is fine', () => {
  const parsed = SessionPayloadSchema.parse(validProdBody);
  expect(parsed.mcp_servers).toBeUndefined();
});

test('mcp_servers accepts bearer auth', () => {
  const parsed = SessionPayloadSchema.parse({
    ...validProdBody,
    mcp_servers: [
      { label: 'github', url: 'https://mcp.gh.example/', auth: { bearer: 'tok' } },
    ],
  });
  expect(parsed.mcp_servers?.[0]?.label).toBe('github');
  expect(parsed.mcp_servers?.[0]?.transport).toBe('streamable_http');
});

test('mcp_servers accepts headers auth', () => {
  const parsed = SessionPayloadSchema.parse({
    ...validProdBody,
    mcp_servers: [
      { label: 'linear', url: 'https://mcp.linear.example/', auth: { headers: { 'X-API-Key': 'k' } } },
    ],
  });
  expect(parsed.mcp_servers?.[0]?.auth).toEqual({ headers: { 'X-API-Key': 'k' } });
});

test('mcp_servers rejects both bearer and headers (xor)', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [
        {
          label: 'x',
          url: 'https://x/',
          auth: { bearer: 't', headers: { 'X-Y': 'z' } } as never,
        },
      ],
    }),
  ).toThrow();
});

test('mcp_servers rejects neither bearer nor headers', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [{ label: 'x', url: 'https://x/', auth: {} as never }],
    }),
  ).toThrow();
});

test('mcp_servers label regex enforced', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [{ label: 'BadLabel!', url: 'https://x/', auth: { bearer: 't' } }],
    }),
  ).toThrow();
});

test('mcp_servers rejects duplicate labels', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [
        { label: 'gh', url: 'https://x/', auth: { bearer: 't' } },
        { label: 'gh', url: 'https://y/', auth: { bearer: 'u' } },
      ],
    }),
  ).toThrow(/unique/);
});

test('mcp_servers rejects unknown transport', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [
        { label: 'x', url: 'https://x/', auth: { bearer: 't' }, transport: 'stdio' as never },
      ],
    }),
  ).toThrow();
});

test('mcp_servers rejects empty headers map', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [{ label: 'x', url: 'https://x/', auth: { headers: {} as never } }],
    }),
  ).toThrow(/non-empty/);
});

test('mcp_servers rejects bad header name', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      mcp_servers: [
        {
          label: 'x',
          url: 'https://x/',
          auth: { headers: { 'Bad Header\r\nInjection': 'v' } },
        },
      ],
    }),
  ).toThrow();
});

test('tools.rag still rejected as unsupported_field', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...validProdBody,
      tools: { rag: { backend: 'opensearch' } } as never,
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/session-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement schema additions**

Modify `/home/joao/augchatd/src/config/session-schema.ts`. Add before `SessionPayloadSchema`:

```typescript
const McpAuthSchema = z.union([
  z.object({ bearer: z.string().min(1) }).strict(),
  z
    .object({
      headers: z
        .record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.string())
        .refine((h) => Object.keys(h).length >= 1, { message: 'headers must be non-empty' }),
    })
    .strict(),
]);

export const McpServerSchema = z
  .object({
    label: z.string().regex(/^[a-z0-9_]{1,32}$/),
    url: z.string().url(),
    auth: McpAuthSchema,
    transport: z.enum(['sse', 'streamable_http']).default('streamable_http'),
  })
  .strict();

export type McpServer = z.infer<typeof McpServerSchema>;
```

Then modify the existing `SessionPayloadSchema` to include `mcp_servers`:

```typescript
export const SessionPayloadSchema = z
  .object({
    user_id: z.string().min(1),
    system_prompt: z.string().default('You are a helpful assistant.'),
    model: ModelSchema,
    storage: StorageSchema, // Fatia 2 made this required object
    mcp_servers: z
      .array(McpServerSchema)
      .optional()
      .refine(
        (arr) => !arr || new Set(arr.map((s) => s.label)).size === arr.length,
        { message: 'mcp_servers labels must be unique' },
      ),
  })
  .strict();
```

Note: keep the demo-builder pattern Fatia 2 introduced (which makes `storage` optional in demo). Don't touch that helper here — just the strict prod schema.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/session-schema.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/session-schema.ts tests/config/session-schema.test.ts
git commit -m "feat(config): add mcp_servers to SessionPayloadSchema (label, url, auth xor, transport)"
```

---

### Task 3: Demo config — parse DEMO_MCP_SERVERS JSON

**Files:**
- Modify: `src/config/demo.ts`
- Modify: `tests/config/demo.test.ts`

Per spec §4.1.2.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/config/demo.test.ts`:

```typescript
test('DEMO_MCP_SERVERS parsed as JSON array of McpServer', () => {
  const env = {
    ...baseEnv,
    DEMO_MCP_SERVERS: JSON.stringify([
      { label: 'gh', url: 'https://mcp/', auth: { bearer: 't' } },
    ]),
  };
  const sess = buildDemoSession(env);
  expect(sess.mcp_servers).toHaveLength(1);
  expect(sess.mcp_servers?.[0]?.label).toBe('gh');
});

test('absent DEMO_MCP_SERVERS leaves mcp_servers undefined', () => {
  const sess = buildDemoSession(baseEnv);
  expect(sess.mcp_servers).toBeUndefined();
});

test('invalid DEMO_MCP_SERVERS JSON throws categorized error', () => {
  expect(() =>
    buildDemoSession({ ...baseEnv, DEMO_MCP_SERVERS: 'not-json' }),
  ).toThrow(/DEMO_MCP_SERVERS/);
});

test('valid JSON but invalid schema throws', () => {
  expect(() =>
    buildDemoSession({
      ...baseEnv,
      DEMO_MCP_SERVERS: JSON.stringify([{ label: 'BAD!', url: 'https://x/', auth: {} }]),
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement DEMO_MCP_SERVERS parsing**

Modify `/home/joao/augchatd/src/config/demo.ts`. Inside `buildDemoSession`, before constructing `payload`:

```typescript
let mcpServers: unknown;
if (env.DEMO_MCP_SERVERS !== undefined) {
  try {
    mcpServers = JSON.parse(env.DEMO_MCP_SERVERS);
  } catch {
    throw new Error('DEMO_MCP_SERVERS: invalid JSON');
  }
}
```

Then add `mcp_servers: mcpServers` to the `payload` object literal (alongside `storage`):

```typescript
const payload: unknown = {
  user_id: 'demo-user',
  system_prompt: env.DEMO_SYSTEM_PROMPT,
  model: { ... },
  storage: env.DEMO_STORAGE_S3 ? JSON.parse(env.DEMO_STORAGE_S3) : undefined,
  mcp_servers: mcpServers,
};
```

Validation comes for free via the existing `SessionPayloadSchema.parse(payload)`.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/demo.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/demo.ts tests/config/demo.test.ts
git commit -m "feat(config): parse DEMO_MCP_SERVERS as JSON in demo builder"
```

---

### Task 4: SessionEntry — add mcpClients map and onEvict close

**Files:**
- Modify: `src/auth/sessions.ts`
- Modify: `tests/auth/sessions.test.ts`

Per spec §5.2. SessionEntry gains `mcpClients: Map<string /* label */, McpClientHandle>`. Eviction (TTL, delete, shutdown) calls `close()` on each handle. We forward-declare the handle type here so the file does not depend on `src/mcp/`.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/auth/sessions.test.ts`:

```typescript
test('SessionEntry mcpClients defaults to empty map; evict closes each handle', () => {
  const closed: string[] = [];
  const store = createSessionStore({
    onEvict: (entry) => {
      for (const handle of entry.mcpClients.values()) {
        handle.close();
        closed.push(handle.label);
      }
    },
  });
  store.put('sid_a', {
    ...baseEntry(),
    mcpClients: new Map([
      ['gh', { label: 'gh', close: () => {}, tools: [], closed: false } as never],
      ['linear', { label: 'linear', close: () => {}, tools: [], closed: false } as never],
    ]),
  });
  store.delete('sid_a');
  expect(closed.sort()).toEqual(['gh', 'linear']);
});

test('expired entry triggers onEvict with mcpClients', () => {
  const closed: string[] = [];
  const store = createSessionStore({
    onEvict: (entry) => {
      entry.mcpClients.forEach((h) => closed.push(h.label));
    },
  });
  store.put('sid_a', {
    ...baseEntry({ expiresAt: Date.now() - 1 }),
    mcpClients: new Map([['gh', { label: 'gh', close: () => {}, tools: [], closed: false } as never]]),
  });
  expect(store.get('sid_a')).toBeUndefined();
  expect(closed).toEqual(['gh']);
});
```

Adjust `baseEntry()` helper at the top of the file to include `mcpClients: new Map()` so older tests still pass.

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/auth/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `SessionEntry` interface and store**

Modify `/home/joao/augchatd/src/auth/sessions.ts`. Forward-declare the handle (so we don't import from `src/mcp/`):

```typescript
export interface McpClientHandleLike {
  label: string;
  close(): void;
  closed: boolean;
}
```

Add to `SessionEntry`:

```typescript
  mcpClients: Map<string, McpClientHandleLike>;
```

Eviction already routes through `onEvict` from Fatia 2's Task 6 — the new `mcpClients` is just another field that callbacks can inspect. No change needed to the store's mechanics.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/auth/sessions.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/auth/sessions.ts tests/auth/sessions.test.ts
git commit -m "feat(auth): SessionEntry gains mcpClients map; onEvict can close them"
```

---

### Task 5: MCP types module

**Files:**
- Create: `src/mcp/types.ts`

Shared types used across the `src/mcp/` package and (via `McpClientHandleLike`) by `src/auth/sessions.ts`.

- [ ] **Step 1: Create types**

Create `/home/joao/augchatd/src/mcp/types.ts`:

```typescript
import type { ZodType } from 'zod';
import type { McpClientHandleLike } from '../auth/sessions';

export type McpAuthMode = 'bearer' | 'headers';

export type McpErrorKind =
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'credentials_expired'
  | '5xx'
  | 'invalid_response'
  | 'invalid_tools_schema'
  | 'protocol_error';

export interface McpError extends Error {
  isMcpError: true;
  kind: McpErrorKind;
  serverLabel: string;
  toolName?: string;
  issue?: string;
}

export class McpUnauthorizedError extends Error {
  readonly isMcpError = true as const;
  readonly kind: McpErrorKind = 'credentials_expired';
  constructor(readonly serverLabel: string) {
    super('mcp_credentials_expired');
    this.name = 'McpUnauthorizedError';
  }
}

export function isMcpError(e: unknown): e is McpError {
  return typeof e === 'object' && e !== null && (e as { isMcpError?: boolean }).isMcpError === true;
}

export function makeMcpError(
  kind: McpErrorKind,
  serverLabel: string,
  extra: { toolName?: string; issue?: string } = {},
): McpError {
  const err = new Error(`mcp_${kind}`) as McpError;
  err.isMcpError = true;
  err.kind = kind;
  err.serverLabel = serverLabel;
  if (extra.toolName !== undefined) err.toolName = extra.toolName;
  if (extra.issue !== undefined) err.issue = extra.issue;
  return err;
}

export interface McpToolDef {
  name: string;          // original from server
  exposedName: string;   // `${label}_${name}`
  description: string | undefined;
  inputSchema: ZodType;
}

export interface McpClientHandle extends McpClientHandleLike {
  label: string;
  url: string;            // ⚠ never log, never expose to stream
  transport: 'sse' | 'streamable_http';
  authMode: McpAuthMode;
  tools: McpToolDef[];
  closed: boolean;
  /** Calls a tool. Throws McpUnauthorizedError on 401; throws McpError for transport/protocol kinds; throws an AbortError when signal aborts. */
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  close(): void;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/types.ts
git commit -m "feat(mcp): shared types (handle, errors, tool def)"
```

---

### Task 6: MCP client — interface + SDK-backed impl + fake

**Files:**
- Create: `src/mcp/client.ts`
- Create: `tests/mcp/client.test.ts`

Wraps `@modelcontextprotocol/sdk` so the rest of the code stays decoupled. Same pattern as `S3Client` from Fatia 2.

- [ ] **Step 1: Add SDK dependency**

Run: `bun add @modelcontextprotocol/sdk@^1.0.0`
Expected: package.json updated; lockfile updated.

- [ ] **Step 2: Write failing tests**

Create `/home/joao/augchatd/tests/mcp/client.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { z } from 'zod';
import { createFakeMcpClient } from '../../src/mcp/client';
import { McpUnauthorizedError, isMcpError } from '../../src/mcp/types';

test('fake client returns programmed tools/list', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [
    { name: 'search', description: 'search code', inputSchema: { type: 'object' } },
  ]);
  const tools = await fake.listTools({
    label: 'gh',
    url: 'https://x/',
    transport: 'streamable_http',
    auth: { bearer: 't' },
  });
  expect(tools.map((t) => t.name)).toEqual(['search']);
});

test('fake client returns programmed tool result', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [
    { name: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
  ]);
  fake.programResult('gh', 'echo', { ok: true, msg: 'hi' });
  const r = await fake.callTool({
    label: 'gh',
    url: 'https://x/',
    transport: 'streamable_http',
    auth: { bearer: 't' },
  }, 'echo', { msg: 'hi' }, new AbortController().signal);
  expect(r).toEqual({ ok: true, msg: 'hi' });
});

test('fake client raises McpUnauthorizedError when programmed', async () => {
  const fake = createFakeMcpClient();
  fake.programInitFailure('gh', 'credentials_expired');
  await expect(
    fake.listTools({ label: 'gh', url: 'https://x/', transport: 'streamable_http', auth: { bearer: 't' } }),
  ).rejects.toBeInstanceOf(McpUnauthorizedError);
});

test('fake client raises categorized McpError', async () => {
  const fake = createFakeMcpClient();
  fake.programInitFailure('gh', 'timeout');
  try {
    await fake.listTools({ label: 'gh', url: 'https://x/', transport: 'streamable_http', auth: { bearer: 't' } });
    throw new Error('should have thrown');
  } catch (e) {
    expect(isMcpError(e)).toBe(true);
    expect((e as { kind: string }).kind).toBe('timeout');
  }
});

test('fake client callTool honors AbortSignal', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [{ name: 'slow', inputSchema: { type: 'object' } }]);
  fake.programDelay('gh', 'slow', 50);
  const ac = new AbortController();
  const p = fake.callTool(
    { label: 'gh', url: 'https://x/', transport: 'streamable_http', auth: { bearer: 't' } },
    'slow',
    {},
    ac.signal,
  );
  ac.abort();
  await expect(p).rejects.toThrow(/abort/i);
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test tests/mcp/client.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the interface, real impl, and fake**

Create `/home/joao/augchatd/src/mcp/client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { makeMcpError, McpUnauthorizedError, type McpErrorKind } from './types';
import type { McpServer } from '../config/session-schema';

export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema; translated to Zod in src/mcp/tools.ts
}

export interface McpClient {
  /** Connects and runs initialize + tools/list. Throws McpUnauthorizedError on 401. Throws McpError for other categorized failures. */
  listTools(server: McpServer): Promise<McpListedTool[]>;
  /** Calls a tool. Throws McpUnauthorizedError on 401. Throws McpError for categorized transport/protocol failures. AbortSignal aborts. */
  callTool(server: McpServer, toolName: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  /** Releases any underlying transport for this server (idempotent). */
  closeServer(label: string): void;
}

// --- Real implementation backed by @modelcontextprotocol/sdk ---

function buildHeaders(server: McpServer): Record<string, string> {
  if ('bearer' in server.auth) return { Authorization: `Bearer ${server.auth.bearer}` };
  return { ...server.auth.headers };
}

function classify(err: unknown): McpErrorKind {
  const msg = String((err as { message?: string })?.message ?? err);
  if (/abort/i.test(msg)) throw err; // bubble AbortError as-is
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'dns';
  if (/ECONNREFUSED|ECONNRESET|connect/i.test(msg)) return 'connect';
  if (/TLS|certificate|self.?signed/i.test(msg)) return 'tls';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/5\d\d|server error/i.test(msg)) return '5xx';
  if (/protocol|version|capabilities/i.test(msg)) return 'protocol_error';
  return 'invalid_response';
}

function createTransport(server: McpServer) {
  const url = new URL(server.url);
  const headers = buildHeaders(server);
  if (server.transport === 'sse') {
    return new SSEClientTransport(url, { requestInit: { headers } });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

export function createSdkMcpClient(): McpClient {
  const clients = new Map<string, Client>();
  return {
    async listTools(server) {
      const client = new Client({ name: 'augchatd', version: '0.0.0' }, { capabilities: {} });
      try {
        await client.connect(createTransport(server));
      } catch (err) {
        const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
        if (status === 401) throw new McpUnauthorizedError(server.label);
        throw makeMcpError(classify(err), server.label);
      }
      let listed: { tools: { name: string; description?: string; inputSchema: unknown }[] };
      try {
        listed = await client.listTools();
      } catch (err) {
        const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
        if (status === 401) throw new McpUnauthorizedError(server.label);
        throw makeMcpError(classify(err), server.label);
      }
      clients.set(server.label, client);
      return listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },

    async callTool(server, toolName, args, signal) {
      const client = clients.get(server.label);
      if (!client) throw makeMcpError('protocol_error', server.label, { issue: 'client_not_initialized' });
      let result: { content?: unknown; isError?: boolean; structuredContent?: unknown };
      try {
        result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) {
          throw err;
        }
        const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
        if (status === 401) throw new McpUnauthorizedError(server.label);
        throw makeMcpError(classify(err), server.label, { toolName });
      }
      return result.structuredContent ?? result.content ?? result;
    },

    closeServer(label) {
      const client = clients.get(label);
      if (!client) return;
      try { client.close(); } catch { /* idempotent */ }
      clients.delete(label);
    },
  };
}

// --- Fake for tests ---

export interface FakeMcpClient extends McpClient {
  programTools(label: string, tools: McpListedTool[]): void;
  programResult(label: string, toolName: string, result: unknown): void;
  programInitFailure(label: string, kind: McpErrorKind | 'credentials_expired'): void;
  programCallFailure(label: string, toolName: string, kind: McpErrorKind | 'credentials_expired'): void;
  programDelay(label: string, toolName: string, ms: number): void;
}

export function createFakeMcpClient(): FakeMcpClient {
  const tools = new Map<string, McpListedTool[]>();
  const results = new Map<string, unknown>();
  const initFailures = new Map<string, McpErrorKind | 'credentials_expired'>();
  const callFailures = new Map<string, McpErrorKind | 'credentials_expired'>();
  const delays = new Map<string, number>();

  const key = (label: string, tool: string) => `${label}::${tool}`;

  return {
    async listTools(server) {
      const fail = initFailures.get(server.label);
      if (fail === 'credentials_expired') throw new McpUnauthorizedError(server.label);
      if (fail) throw makeMcpError(fail, server.label);
      return tools.get(server.label) ?? [];
    },
    async callTool(server, toolName, _args, signal) {
      const fail = callFailures.get(key(server.label, toolName));
      if (fail === 'credentials_expired') throw new McpUnauthorizedError(server.label);
      if (fail) throw makeMcpError(fail, server.label, { toolName });
      const delay = delays.get(key(server.label, toolName)) ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            (err as { name: string }).name = 'AbortError';
            reject(err);
          });
        });
      }
      if (signal.aborted) {
        const err = new Error('aborted');
        (err as { name: string }).name = 'AbortError';
        throw err;
      }
      return results.get(key(server.label, toolName));
    },
    closeServer(_label) {/* no-op */},
    programTools(label, list) { tools.set(label, list); },
    programResult(label, toolName, result) { results.set(key(label, toolName), result); },
    programInitFailure(label, kind) { initFailures.set(label, kind); },
    programCallFailure(label, toolName, kind) { callFailures.set(key(label, toolName), kind); },
    programDelay(label, toolName, ms) { delays.set(key(label, toolName), ms); },
  };
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test tests/mcp/client.test.ts`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client.ts tests/mcp/client.test.ts package.json bun.lockb
git commit -m "feat(mcp): McpClient interface + SDK-backed impl + fake"
```

---

### Task 7: MCP tools — translate tools/list to AI SDK tool definitions

**Files:**
- Create: `src/mcp/tools.ts`
- Create: `tests/mcp/tools.test.ts`

Translates a list of `McpListedTool` (JSON Schema input) for a given server into `McpToolDef[]` (Zod input schema, exposed name `<label>_<name>`).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/mcp/tools.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { translateMcpTools } from '../../src/mcp/tools';
import { isMcpError } from '../../src/mcp/types';

test('translates a simple tool', () => {
  const out = translateMcpTools('gh', [
    {
      name: 'search',
      description: 'search code',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]!.name).toBe('search');
  expect(out[0]!.exposedName).toBe('gh_search');
  expect(out[0]!.description).toBe('search code');
  const parsed = out[0]!.inputSchema.safeParse({ query: 'hi' });
  expect(parsed.success).toBe(true);
});

test('rejects required field missing', () => {
  const out = translateMcpTools('gh', [
    {
      name: 'search',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  ]);
  expect(out[0]!.inputSchema.safeParse({}).success).toBe(false);
});

test('invalid schema bubbles as McpError invalid_tools_schema', () => {
  try {
    translateMcpTools('gh', [{ name: 'broken', inputSchema: 'not-an-object' as never }]);
    throw new Error('should have thrown');
  } catch (e) {
    expect(isMcpError(e)).toBe(true);
    expect((e as { kind: string }).kind).toBe('invalid_tools_schema');
    expect((e as { toolName: string }).toolName).toBe('broken');
  }
});

test('description omitted when absent', () => {
  const out = translateMcpTools('gh', [
    { name: 'noop', inputSchema: { type: 'object' } },
  ]);
  expect(out[0]!.description).toBeUndefined();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/mcp/tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement translator**

Create `/home/joao/augchatd/src/mcp/tools.ts`:

```typescript
import { z, type ZodType } from 'zod';
import { makeMcpError, type McpToolDef } from './types';
import type { McpListedTool } from './client';

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
}

function compileJsonSchema(schema: JsonSchema): ZodType {
  if (!schema || typeof schema !== 'object') {
    throw new Error('schema must be an object');
  }
  if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
  switch (schema.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(schema.items ? compileJsonSchema(schema.items) : z.unknown());
    case 'object': {
      const shape: Record<string, ZodType> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const compiled = compileJsonSchema(sub);
        shape[key] = required.has(key) ? compiled : compiled.optional();
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

export function translateMcpTools(label: string, listed: McpListedTool[]): McpToolDef[] {
  return listed.map((t) => {
    let inputSchema: ZodType;
    try {
      inputSchema = compileJsonSchema(t.inputSchema as JsonSchema);
    } catch (e) {
      throw makeMcpError('invalid_tools_schema', label, {
        toolName: t.name,
        issue: String((e as Error).message),
      });
    }
    return {
      name: t.name,
      exposedName: `${label}_${t.name}`,
      description: t.description,
      inputSchema,
    };
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/mcp/tools.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat(mcp): translate tools/list JSON Schema to AI SDK Zod tool defs"
```

---

### Task 8: MCP eager init

**Files:**
- Create: `src/mcp/eager-init.ts`
- Create: `tests/mcp/eager-init.test.ts`

Per spec §2 (eager init) + §4.5 (error codes). For each server in `mcp_servers`, sequentially: `listTools`, translate, build a handle. Any failure throws `McpError` (or `McpUnauthorizedError`) — the caller decides whether to 400 (prod) or `exit 1` (demo). Successful handles include a `callTool(name, args, signal)` closure that delegates to the shared client and a `close()` that calls `closeServer(label)`.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/mcp/eager-init.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createFakeMcpClient } from '../../src/mcp/client';
import { eagerInitMcp } from '../../src/mcp/eager-init';
import { isMcpError, McpUnauthorizedError } from '../../src/mcp/types';

const server = (label: string, extra: Partial<{ url: string; auth: unknown; transport: 'sse' | 'streamable_http' }> = {}) =>
  ({
    label,
    url: extra.url ?? 'https://mcp/',
    transport: (extra.transport ?? 'streamable_http') as 'sse' | 'streamable_http',
    auth: (extra.auth ?? { bearer: 't' }) as never,
  });

test('successful init returns Map<label, handle> with translated tools', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [
    { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ]);
  fake.programTools('linear', [
    { name: 'issue', inputSchema: { type: 'object' } },
  ]);
  const handles = await eagerInitMcp(fake, [server('gh'), server('linear')]);
  expect(handles.size).toBe(2);
  expect(handles.get('gh')?.tools.map((t) => t.exposedName)).toEqual(['gh_search']);
  expect(handles.get('linear')?.tools.map((t) => t.exposedName)).toEqual(['linear_issue']);
});

test('init failure surfaces categorized McpError; previously-created handles are closed', async () => {
  const closed: string[] = [];
  const fake = createFakeMcpClient();
  fake.programTools('gh', [{ name: 'x', inputSchema: { type: 'object' } }]);
  fake.programInitFailure('linear', 'timeout');
  const origClose = fake.closeServer.bind(fake);
  (fake as { closeServer: (l: string) => void }).closeServer = (l: string) => {
    closed.push(l);
    origClose(l);
  };
  try {
    await eagerInitMcp(fake, [server('gh'), server('linear')]);
    throw new Error('should have thrown');
  } catch (e) {
    expect(isMcpError(e)).toBe(true);
    expect((e as { kind: string }).kind).toBe('timeout');
    expect((e as { serverLabel: string }).serverLabel).toBe('linear');
  }
  expect(closed).toContain('gh'); // earlier success was rolled back
});

test('401 from listTools bubbles as McpUnauthorizedError', async () => {
  const fake = createFakeMcpClient();
  fake.programInitFailure('gh', 'credentials_expired');
  await expect(eagerInitMcp(fake, [server('gh')])).rejects.toBeInstanceOf(McpUnauthorizedError);
});

test('handle.callTool delegates to client; close marks closed', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [{ name: 'echo', inputSchema: { type: 'object' } }]);
  fake.programResult('gh', 'echo', { ok: 1 });
  const handles = await eagerInitMcp(fake, [server('gh')]);
  const h = handles.get('gh')!;
  const r = await h.callTool('echo', {}, new AbortController().signal);
  expect(r).toEqual({ ok: 1 });
  h.close();
  expect(h.closed).toBe(true);
});

test('empty list returns empty map', async () => {
  const fake = createFakeMcpClient();
  const handles = await eagerInitMcp(fake, []);
  expect(handles.size).toBe(0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/mcp/eager-init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement eager-init**

Create `/home/joao/augchatd/src/mcp/eager-init.ts`:

```typescript
import type { McpClient } from './client';
import { translateMcpTools } from './tools';
import type { McpClientHandle } from './types';
import type { McpServer } from '../config/session-schema';

export async function eagerInitMcp(
  client: McpClient,
  servers: McpServer[],
): Promise<Map<string, McpClientHandle>> {
  const handles = new Map<string, McpClientHandle>();
  for (const server of servers) {
    try {
      const listed = await client.listTools(server);
      const tools = translateMcpTools(server.label, listed);
      const handle: McpClientHandle = {
        label: server.label,
        url: server.url,
        transport: server.transport,
        authMode: 'bearer' in server.auth ? 'bearer' : 'headers',
        tools,
        closed: false,
        async callTool(name, args, signal) {
          if (this.closed) throw new Error('mcp_client_closed');
          return client.callTool(server, name, args, signal);
        },
        close() {
          if (this.closed) return;
          this.closed = true;
          client.closeServer(server.label);
        },
      };
      handles.set(server.label, handle);
    } catch (err) {
      // roll back previously initialized handles
      for (const h of handles.values()) h.close();
      throw err;
    }
  }
  return handles;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/mcp/eager-init.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/eager-init.ts tests/mcp/eager-init.test.ts
git commit -m "feat(mcp): eager-init coordinator with rollback on failure"
```

---

### Task 9: MCP sanitization helper

**Files:**
- Create: `src/mcp/sanitize.ts`
- Create: `tests/mcp/sanitize.test.ts`

Per spec §4.7. Recursive strip of keys (`url`, `endpoint`, `headers`, `request_id`, `traceparent`, and any key matching `/^x-.*-internal-.*/i`). Preserves the rest verbatim. Also exposes a function that takes a Vercel AI SDK data-stream **chunk line** (`9:{...}` etc.) and re-emits it sanitized.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/mcp/sanitize.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { sanitizeObject, sanitizeStreamLine, SENSITIVE_KEYS_RE } from '../../src/mcp/sanitize';

test('strips known sensitive keys at root', () => {
  expect(sanitizeObject({
    url: 'https://x', headers: { a: 'b' }, request_id: 'r',
    tool_call_id: '1', args: { ok: true },
  })).toEqual({ tool_call_id: '1', args: { ok: true } });
});

test('strips recursively in nested values', () => {
  expect(sanitizeObject({
    result: { headers: { a: 'b' }, body: 'ok', meta: { url: 'x', count: 3 } },
  })).toEqual({ result: { body: 'ok', meta: { count: 3 } } });
});

test('preserves arrays and primitives', () => {
  expect(sanitizeObject({ list: [{ headers: { x: 'y' }, value: 1 }, 2, 'three'] })).toEqual({
    list: [{ value: 1 }, 2, 'three'],
  });
});

test('SENSITIVE_KEYS_RE matches x-*-internal-* and traceparent', () => {
  expect(SENSITIVE_KEYS_RE.test('x-amzn-internal-trace')).toBe(true);
  expect(SENSITIVE_KEYS_RE.test('traceparent')).toBe(true);
  expect(SENSITIVE_KEYS_RE.test('x-foo')).toBe(false);
});

test('sanitizeStreamLine handles vercel data stream prefix', () => {
  const line = '9:{"toolCallId":"id1","toolName":"gh_search","args":{"q":"hi"},"url":"https://mcp/"}';
  const out = sanitizeStreamLine(line);
  const parsed = JSON.parse(out.slice(2));
  expect(parsed.url).toBeUndefined();
  expect(parsed.toolCallId).toBe('id1');
});

test('sanitizeStreamLine passes non-JSON lines through unchanged', () => {
  expect(sanitizeStreamLine('0:"text"')).toBe('0:"text"');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/mcp/sanitize.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement sanitizer**

Create `/home/joao/augchatd/src/mcp/sanitize.ts`:

```typescript
const FIXED_KEYS = new Set([
  'url',
  'endpoint',
  'headers',
  'request_id',
  'traceparent',
  'authorization',
]);

export const SENSITIVE_KEYS_RE = /^(x-[\w-]*-internal-[\w-]*|traceparent)$/i;

function shouldDrop(key: string): boolean {
  return FIXED_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS_RE.test(key);
}

export function sanitizeObject(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sanitizeObject);
  if (input === null || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (shouldDrop(k)) continue;
    out[k] = sanitizeObject(v);
  }
  return out;
}

export function sanitizeStreamLine(line: string): string {
  const colon = line.indexOf(':');
  if (colon < 0) return line;
  const prefix = line.slice(0, colon + 1);
  const rest = line.slice(colon + 1);
  if (!rest) return line;
  // Only attempt JSON parse for object/array payloads.
  const first = rest.trimStart()[0];
  if (first !== '{' && first !== '[') return line;
  try {
    const parsed = JSON.parse(rest);
    return prefix + JSON.stringify(sanitizeObject(parsed));
  } catch {
    return line;
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/mcp/sanitize.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/sanitize.ts tests/mcp/sanitize.test.ts
git commit -m "feat(mcp): recursive sanitizer + Vercel AI data-stream line wrapper"
```

---

### Task 10: Bounded concurrency Promise pool

**Files:**
- Create: `src/mcp/pool.ts`
- Create: `tests/mcp/pool.test.ts`

Per spec §6 (concorrência). Used by the chat module to wrap `execute()` calls so at most `AUGCHATD_MCP_PARALLEL_CAP` are active. Pool is per-turn (new instance per `runChat`).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/mcp/pool.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createPool } from '../../src/mcp/pool';

test('never exceeds the concurrency cap', async () => {
  const pool = createPool(2);
  let active = 0;
  let maxActive = 0;
  const work = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  await Promise.all(Array.from({ length: 8 }, () => pool.run(work)));
  expect(maxActive).toBeLessThanOrEqual(2);
});

test('returns each task’s value', async () => {
  const pool = createPool(2);
  const results = await Promise.all([1, 2, 3, 4].map((n) => pool.run(async () => n * 2)));
  expect(results).toEqual([2, 4, 6, 8]);
});

test('propagates errors', async () => {
  const pool = createPool(2);
  await expect(pool.run(async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
});

test('cap=1 enforces strict sequential', async () => {
  const pool = createPool(1);
  const order: number[] = [];
  await Promise.all([
    pool.run(async () => { await new Promise(r => setTimeout(r, 10)); order.push(1); }),
    pool.run(async () => { order.push(2); }),
  ]);
  expect(order).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/mcp/pool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement pool**

Create `/home/joao/augchatd/src/mcp/pool.ts`:

```typescript
export interface Pool {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createPool(cap: number): Pool {
  if (cap <= 0) throw new Error('cap must be positive');
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < cap) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active++;
        resolve();
      });
    });
  };

  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/mcp/pool.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/pool.ts tests/mcp/pool.test.ts
git commit -m "feat(mcp): bounded concurrency Promise pool"
```

---

### Task 11: Wire eager MCP init into POST /sessions

**Files:**
- Modify: `src/server/routes/sessions.ts`
- Modify: `tests/server/routes/sessions.test.ts`

Per spec §4.2 + §4.5. After the S3 smoke test passes, run `eagerInitMcp` if `payload.mcp_servers?.length`. Success: attach handles to the new `SessionEntry`. Failure: map to a 400 with the appropriate code; do not register the session. Also: `DELETE /sessions/{id}` now closes the MCP clients on the entry before evicting.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/server/routes/sessions.test.ts`:

```typescript
import { createFakeMcpClient } from '../../../src/mcp/client';

function appWithTenantMcp(tenant: string) {
  const sessions = createSessionStore({});
  const jwt = createJwtModule({ currentKey: KEY, ttlSeconds: 60 });
  const s3 = createFakeS3Client();
  const mcp = createFakeMcpClient();
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('tenantId', tenant); await next(); });
  app.route('/', sessionsRoutes({ sessions, jwt, s3, mcp }));
  return { app, sessions, s3, mcp };
}

test('POST /sessions with mcp_servers eager-inits and attaches handles', async () => {
  const { app, sessions, mcp } = appWithTenantMcp('urn:t:acme');
  mcp.programTools('gh', [{ name: 'search', inputSchema: { type: 'object' } }]);
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' } }],
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const entry = sessions.get(body.session_id)!;
  expect(entry.mcpClients.get('gh')?.tools[0]?.exposedName).toBe('gh_search');
});

test('POST /sessions returns 400 mcp_unreachable when MCP timeout at init', async () => {
  const { app, mcp } = appWithTenantMcp('urn:t:acme');
  mcp.programInitFailure('gh', 'timeout');
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' } }],
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('mcp_unreachable');
  expect(body.detail.server_label).toBe('gh');
  expect(body.detail.kind).toBe('timeout');
});

test('POST /sessions returns 400 mcp_credentials_expired on 401 at init', async () => {
  const { app, mcp } = appWithTenantMcp('urn:t:acme');
  mcp.programInitFailure('gh', 'credentials_expired');
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' } }],
    }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('mcp_credentials_expired');
});

test('POST /sessions returns 400 mcp_invalid_tools_schema when schema bad', async () => {
  const { app, mcp } = appWithTenantMcp('urn:t:acme');
  mcp.programTools('gh', [{ name: 'broken', inputSchema: 'not-an-object' as never }]);
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' } }],
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('mcp_invalid_tools_schema');
  expect(body.detail.tool_name).toBe('broken');
});

test('DELETE /sessions/{id} closes MCP clients', async () => {
  const { app, sessions, mcp } = appWithTenantMcp('urn:t:acme');
  mcp.programTools('gh', [{ name: 'x', inputSchema: { type: 'object' } }]);
  const createRes = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' } }],
    }),
  });
  const { session_id } = await createRes.json();
  const entry = sessions.get(session_id)!;
  const handle = entry.mcpClients.get('gh')!;
  expect(handle.closed).toBe(false);
  const del = await app.request(`/sessions/${session_id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(handle.closed).toBe(true);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/sessions.test.ts`
Expected: FAIL (route does not take `mcp`).

- [ ] **Step 3: Modify route**

Modify `/home/joao/augchatd/src/server/routes/sessions.ts`. Add to imports:

```typescript
import { eagerInitMcp } from '../../mcp/eager-init';
import type { McpClient } from '../../mcp/client';
import { isMcpError, McpUnauthorizedError } from '../../mcp/types';
```

Extend `SessionsRouteOptions`:

```typescript
export interface SessionsRouteOptions {
  sessions: SessionStore;
  jwt: JwtModule;
  s3: S3Client;
  mcp: McpClient;
  ttlSeconds?: number;
}
```

Inside the `POST /sessions` handler, **after** the `smokeTestS3` block and **before** building the `SessionEntry`, insert:

```typescript
    let mcpClients = new Map<string, McpClientHandle>();
    if (payload.mcp_servers && payload.mcp_servers.length > 0) {
      try {
        mcpClients = await eagerInitMcp(opts.mcp, payload.mcp_servers);
      } catch (e) {
        if (e instanceof McpUnauthorizedError) {
          return c.json({
            error: 'mcp_credentials_expired',
            detail: { server_label: e.serverLabel },
          }, 400);
        }
        if (isMcpError(e)) {
          const code =
            e.kind === 'invalid_tools_schema'
              ? 'mcp_invalid_tools_schema'
              : e.kind === 'protocol_error'
                ? 'mcp_protocol_error'
                : 'mcp_unreachable';
          const detail: Record<string, unknown> = { server_label: e.serverLabel };
          if (e.kind !== 'invalid_tools_schema' && e.kind !== 'protocol_error') {
            detail.kind = e.kind;
          }
          if (e.toolName) detail.tool_name = e.toolName;
          if (e.issue) detail.issue = e.issue;
          return c.json({ error: code, detail }, 400);
        }
        throw e;
      }
    }
```

Add `mcpClients` to the `SessionEntry` literal:

```typescript
    const entry: SessionEntry = {
      tenantId,
      // ... existing fields ...
      conversationsTouched: new Set<string>(),
      mcpClients,
    };
```

Also import `McpClientHandle` from `../../mcp/types` for the local `Map` type annotation.

In the `DELETE /sessions/:id` handler, before `opts.sessions.delete(id)`:

```typescript
    for (const handle of entry.mcpClients.values()) handle.close();
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/sessions.test.ts`
Expected: all passing (Fatia 2 tests + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sessions.ts tests/server/routes/sessions.test.ts
git commit -m "feat(server): wire eager MCP init into POST /sessions with categorized errors"
```

---

### Task 12: Messages repo — appendMessage carries tool_calls + insertToolResult helper

**Files:**
- Modify: `src/storage/messages.ts`
- Modify: `tests/storage/messages.test.ts`

Per spec §5.1. The schema column `tool_calls` exists since Fatia 1; we now wire `appendMessage` to accept it as a JSON string. Add `insertToolResult({conversationId, toolCallId, status, result?, error?})` which creates a `role='tool'` row with the structured `content`.

- [ ] **Step 1: Add failing tests**

Append to `/home/joao/augchatd/tests/storage/messages.test.ts`:

```typescript
import { insertToolResult } from '../../src/storage/messages';

test('appendMessage persists tool_calls JSON', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  appendMessage(db, {
    id: 'a1',
    conversationId: 'c',
    role: 'assistant',
    content: 'calling tools',
    toolCalls: JSON.stringify([{ tool_call_id: 't1', tool_name: 'gh_search', args: { q: 'x' } }]),
    createdAt: 1,
    modelIdUsed: 'm',
  });
  const [msg] = listMessages(db, 'c');
  expect(msg!.toolCalls).toContain('gh_search');
});

test('insertToolResult creates role=tool row with structured content', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  insertToolResult(db, {
    id: 't1-result',
    conversationId: 'c',
    toolCallId: 't1',
    status: 'ok',
    result: { foo: 'bar' },
    createdAt: 2,
  });
  const [msg] = listMessages(db, 'c');
  expect(msg!.role).toBe('tool');
  const parsed = JSON.parse(msg!.content);
  expect(parsed.tool_call_id).toBe('t1');
  expect(parsed.status).toBe('ok');
  expect(parsed.result).toEqual({ foo: 'bar' });
});

test('insertToolResult error status carries error detail', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  insertToolResult(db, {
    id: 't2',
    conversationId: 'c',
    toolCallId: 't2',
    status: 'error',
    error: { code: 'mcp_timeout', server_label: 'gh' },
    createdAt: 3,
  });
  const parsed = JSON.parse(listMessages(db, 'c')[0]!.content);
  expect(parsed.status).toBe('error');
  expect(parsed.error.code).toBe('mcp_timeout');
});

test('insertToolResult cancelled status', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  insertToolResult(db, {
    id: 't3',
    conversationId: 'c',
    toolCallId: 't3',
    status: 'cancelled',
    createdAt: 4,
  });
  const parsed = JSON.parse(listMessages(db, 'c')[0]!.content);
  expect(parsed.status).toBe('cancelled');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/messages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify messages repo**

The existing `appendMessage` already supports `toolCalls` (from Fatia 1, currently always undefined). Verify by reading the existing impl. Add the new helper to `/home/joao/augchatd/src/storage/messages.ts`:

```typescript
export interface ToolResultRow {
  id: string;
  conversationId: string;
  toolCallId: string;
  status: 'ok' | 'error' | 'cancelled';
  result?: unknown;
  error?: { code: string; server_label: string };
  createdAt: number;
}

export function insertToolResult(db: Database, row: ToolResultRow): void {
  const payload: Record<string, unknown> = { tool_call_id: row.toolCallId, status: row.status };
  if (row.status === 'ok') payload.result = row.result;
  if (row.status === 'error') payload.error = row.error;
  appendMessage(db, {
    id: row.id,
    conversationId: row.conversationId,
    role: 'tool',
    content: JSON.stringify(payload),
    createdAt: row.createdAt,
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/messages.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/messages.ts tests/storage/messages.test.ts
git commit -m "feat(storage): tool_calls in appendMessage + insertToolResult helper"
```

---

### Task 13: Hydration — rebuild AI SDK ModelMessages from rows (with tool_use/tool_result)

**Files:**
- Create: `src/chat/hydrate.ts`
- Create: `tests/chat/hydrate.test.ts`

Per spec §5.5. Pass-through verbatim: even if a tool name in history isn't in the current `tools` map, it stays in context.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/chat/hydrate.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { rowsToModelMessages } from '../../src/chat/hydrate';
import type { Message } from '../../src/storage/messages';

function row(over: Partial<Message>): Message {
  return {
    id: over.id ?? crypto.randomUUID(),
    conversationId: 'c',
    role: 'user',
    content: '',
    toolCalls: null,
    modelIdUsed: null,
    createdAt: 0,
    flushedAt: null,
    stoppedByUser: false,
    stoppedByShutdown: false,
    ...over,
  };
}

test('user + assistant text-only rows', () => {
  const msgs = rowsToModelMessages([
    row({ role: 'user', content: 'hi' }),
    row({ role: 'assistant', content: 'hello' }),
  ]);
  expect(msgs).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('assistant with tool_calls produces content parts', () => {
  const msgs = rowsToModelMessages([
    row({
      role: 'assistant',
      content: 'thinking',
      toolCalls: JSON.stringify([
        { tool_call_id: 't1', tool_name: 'gh_search', args: { q: 'x' } },
      ]),
    }),
  ]);
  expect(msgs[0]!.role).toBe('assistant');
  expect(Array.isArray(msgs[0]!.content)).toBe(true);
  const parts = msgs[0]!.content as Array<{ type: string }>;
  expect(parts.find((p) => p.type === 'text')).toBeTruthy();
  expect(parts.find((p) => p.type === 'tool-call')).toBeTruthy();
});

test('tool role row produces tool-result message', () => {
  const msgs = rowsToModelMessages([
    row({
      role: 'tool',
      content: JSON.stringify({ tool_call_id: 't1', status: 'ok', result: { ok: 1 } }),
    }),
  ]);
  expect(msgs[0]!.role).toBe('tool');
  const parts = msgs[0]!.content as Array<{ type: string; toolCallId: string; output: unknown }>;
  expect(parts[0]!.type).toBe('tool-result');
  expect(parts[0]!.toolCallId).toBe('t1');
});

test('tool name from history is preserved even if current tools map is unrelated', () => {
  const msgs = rowsToModelMessages([
    row({
      role: 'assistant',
      content: 'used a gone tool',
      toolCalls: JSON.stringify([
        { tool_call_id: 'x', tool_name: 'github_search', args: {} },
      ]),
    }),
  ]);
  const parts = msgs[0]!.content as Array<{ type: string; toolName?: string }>;
  expect(parts.find((p) => p.type === 'tool-call')?.toolName).toBe('github_search');
});

test('drops empty text part when assistant has only tool calls', () => {
  const msgs = rowsToModelMessages([
    row({
      role: 'assistant',
      content: '',
      toolCalls: JSON.stringify([{ tool_call_id: 't1', tool_name: 'x_y', args: {} }]),
    }),
  ]);
  const parts = msgs[0]!.content as Array<{ type: string }>;
  expect(parts.some((p) => p.type === 'text')).toBe(false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/chat/hydrate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement hydration**

Create `/home/joao/augchatd/src/chat/hydrate.ts`:

```typescript
import type { CoreMessage } from 'ai';
import type { Message } from '../storage/messages';

interface ToolCallEntry {
  tool_call_id: string;
  tool_name: string;
  args: unknown;
}

interface ToolResultContent {
  tool_call_id: string;
  status: 'ok' | 'error' | 'cancelled';
  result?: unknown;
  error?: { code: string; server_label: string };
}

export function rowsToModelMessages(rows: Message[]): CoreMessage[] {
  return rows.map((row): CoreMessage => {
    if (row.role === 'user') {
      return { role: 'user', content: row.content };
    }
    if (row.role === 'assistant') {
      const calls: ToolCallEntry[] = row.toolCalls ? JSON.parse(row.toolCalls) : [];
      if (calls.length === 0) {
        return { role: 'assistant', content: row.content };
      }
      const parts: Array<unknown> = [];
      if (row.content.length > 0) {
        parts.push({ type: 'text', text: row.content });
      }
      for (const c of calls) {
        parts.push({
          type: 'tool-call',
          toolCallId: c.tool_call_id,
          toolName: c.tool_name,
          args: c.args,
        });
      }
      return { role: 'assistant', content: parts as never };
    }
    // role === 'tool'
    const payload: ToolResultContent = JSON.parse(row.content);
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: payload.tool_call_id,
          toolName: '__historical__', // placeholder; AI SDK requires the field
          result: payload.status === 'ok' ? payload.result : { error: payload.error, status: payload.status },
        },
      ] as never,
    };
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/chat/hydrate.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/chat/hydrate.ts tests/chat/hydrate.test.ts
git commit -m "feat(chat): hydrate rows to AI SDK CoreMessage[] with tool_use/tool_result"
```

---

### Task 14: Chat stream — wire tools, maxSteps, parallel cap, per-tool timeout, persistence, sanitization

**Files:**
- Modify: `src/chat/stream.ts`
- Modify: `tests/chat/stream.test.ts`

This is the big one. We extend `runChat` to:

1. Use `rowsToModelMessages` instead of the naïve role+content mapping for history.
2. Build `tools` from `session.mcpClients`. Each tool's `execute(args, { abortSignal })` acquires a slot from a per-turn `Pool(cfg.mcp.parallelCap)`, sets up a per-call timeout (`cfg.mcp.toolTimeoutSeconds`), calls `handle.callTool(name, args, combinedSignal)`, and maps errors to either `{ status, error, ... }` tool result objects or rethrows `McpUnauthorizedError`.
3. Set a `turnAbortController` with `cfg.mcp.turnTimeoutSeconds`. Combine with `input.abortSignal`. Pass combined signal as `abortSignal` to `streamText`.
4. Pass `maxSteps: 10`.
5. `onStepFinish`: for each step that produced tool calls, persist `role='assistant'` row with `tool_calls` JSON and one `role='tool'` row per result via `insertToolResult`.
6. `onFinish`: persist final `role='assistant'` text row if any.
7. Build the response as `Response(toDataStream() ▶ sanitizingTransformStream, headers)`.

This task wires items 1–6. Task 15 wires the sanitizing transform stream + final assembly. Splitting keeps each commit small.

- [ ] **Step 1: Replace existing tests with the new tool-aware setup**

Modify `/home/joao/augchatd/tests/chat/stream.test.ts`. Add imports and shared helpers at the top:

```typescript
import { createFakeMcpClient } from '../../src/mcp/client';
import { eagerInitMcp } from '../../src/mcp/eager-init';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
```

Add this helper that builds a session with optional MCP handles:

```typescript
async function sessionWithMcp(mcp = createFakeMcpClient(), servers: { label: string; tools: Array<{ name: string; result?: unknown }> }[] = []) {
  for (const s of servers) {
    mcp.programTools(s.label, s.tools.map((t) => ({ name: t.name, inputSchema: { type: 'object' } })));
    for (const t of s.tools) {
      if (t.result !== undefined) mcp.programResult(s.label, t.name, t.result);
    }
  }
  const list = servers.map((s) => ({
    label: s.label,
    url: 'https://m/',
    transport: 'streamable_http' as const,
    auth: { bearer: 't' },
  }));
  const handles = await eagerInitMcp(mcp, list);
  return {
    tenantId: 'urn:t:demo',
    userId: 'demo-user',
    modelProvider: 'anthropic' as const,
    modelId: 'm',
    modelApiKey: 'k',
    systemPrompt: 'be brief',
    storage: { s3: { bucket: 'b', prefix: '', region: 'r', accessKeyId: 'a', secretAccessKey: 's', forcePathStyle: false } },
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    stale: false,
    conversationsTouched: new Set<string>(),
    mcpClients: handles,
  };
}
```

Add tests:

```typescript
function modelWithToolCall() {
  return new MockLanguageModelV1({
    doStream: async ({ messages }) => {
      const lastIsTool = messages[messages.length - 1]?.role === 'tool';
      if (lastIsTool) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-delta', textDelta: 'done.' },
              { type: 'finish', finishReason: 'stop', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallType: 'function',
              toolCallId: 'tc1',
              toolName: 'gh_search',
              args: '{"q":"hi"}',
            },
            { type: 'finish', finishReason: 'tool-calls', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

test('runChat executes a tool call and persists role=tool result', async () => {
  const session = await sessionWithMcp(undefined, [
    { label: 'gh', tools: [{ name: 'search', result: { hits: 3 } }] },
  ]);
  const db = openTenantDb(session.tenantId, hotDir);
  ensureConversation(db, 'conv-tool', session.userId);
  const res = await runChat({
    session,
    conversationId: 'conv-tool',
    userMessage: 'find x',
    hotDir,
    config: { toolTimeoutSeconds: 5, turnTimeoutSeconds: 30, parallelCap: 4 },
    abortSignal: new AbortController().signal,
    modelOverride: modelWithToolCall(),
  });
  await res.text();
  const msgs = listMessages(db, 'conv-tool');
  // user + assistant(tool_calls) + tool(result) + assistant(text)
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(msgs[1]!.toolCalls).toContain('gh_search');
  const toolPayload = JSON.parse(msgs[2]!.content);
  expect(toolPayload.status).toBe('ok');
  expect(toolPayload.result).toEqual({ hits: 3 });
});
```

(Keep the original simple tests too — they still pass.)

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/chat/stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify runChat**

Modify `/home/joao/augchatd/src/chat/stream.ts`. Replace the file with:

```typescript
import { streamText, tool, type LanguageModel, type CoreMessage } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { SessionEntry } from '../auth/sessions';
import { openTenantDb } from '../storage/db';
import { ensureConversation } from '../storage/conversations';
import { appendMessage, listMessages, insertToolResult, type Message } from '../storage/messages';
import { rowsToModelMessages } from './hydrate';
import { createPool } from '../mcp/pool';
import { McpUnauthorizedError, isMcpError } from '../mcp/types';
import { log } from '../log';

export interface RunChatConfig {
  toolTimeoutSeconds: number;
  turnTimeoutSeconds: number;
  parallelCap: number;
}

export interface RunChatInput {
  session: SessionEntry;
  conversationId: string;
  userMessage: string;
  hotDir: string;
  config: RunChatConfig;
  abortSignal: AbortSignal;
  modelOverride?: LanguageModel;
}

function resolveModel(session: SessionEntry, override?: LanguageModel): LanguageModel {
  if (override) return override;
  if (session.modelProvider === 'anthropic') {
    return createAnthropic({ apiKey: session.modelApiKey })(session.modelId);
  }
  throw new Error(`unsupported_provider:${session.modelProvider}`);
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) ac.abort(s.reason);
    else s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

function buildTools(session: SessionEntry, pool: ReturnType<typeof createPool>, toolTimeoutMs: number, parentSignal: AbortSignal) {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const handle of session.mcpClients.values()) {
    for (const def of handle.tools) {
      tools[def.exposedName] = tool({
        description: def.description,
        parameters: def.inputSchema as never,
        execute: async (args, { abortSignal }) => {
          return pool.run(async () => {
            const localAc = new AbortController();
            const timer = setTimeout(() => localAc.abort(new Error('mcp_timeout')), toolTimeoutMs);
            const combined = combineSignals(parentSignal, abortSignal ?? new AbortController().signal, localAc.signal);
            try {
              return await handle.callTool(def.name, args, combined);
            } catch (e) {
              clearTimeout(timer);
              if (e instanceof McpUnauthorizedError) throw e;
              if (isMcpError(e)) {
                const code =
                  e.kind === 'timeout' ? 'mcp_timeout'
                  : e.kind === '5xx' ? 'mcp_5xx'
                  : e.kind === 'invalid_response' ? 'mcp_invalid_response'
                  : 'mcp_unreachable';
                return { __augchatd_error: { code, server_label: e.serverLabel } };
              }
              if ((e as { name?: string })?.name === 'AbortError') {
                return { __augchatd_cancelled: true };
              }
              throw e;
            } finally {
              clearTimeout(timer);
            }
          });
        },
      });
    }
  }
  return tools;
}

export async function runChat(input: RunChatInput): Promise<Response> {
  const db = openTenantDb(input.session.tenantId, input.hotDir);
  ensureConversation(db, input.conversationId, input.session.userId);
  input.session.conversationsTouched.add(input.conversationId);

  const userMsgId = crypto.randomUUID();
  appendMessage(db, {
    id: userMsgId,
    conversationId: input.conversationId,
    role: 'user',
    content: input.userMessage,
    createdAt: Date.now(),
  });

  const history = listMessages(db, input.conversationId);
  const messages = rowsToModelMessages(history);

  // Per-turn timers + signals
  const turnAc = new AbortController();
  const turnTimer = setTimeout(
    () => turnAc.abort(new Error('total_timeout')),
    input.config.turnTimeoutSeconds * 1000,
  );
  const combinedSignal = combineSignals(input.abortSignal, turnAc.signal);

  const pool = createPool(input.config.parallelCap);
  const tools = buildTools(input.session, pool, input.config.toolTimeoutSeconds * 1000, combinedSignal);

  const model = resolveModel(input.session, input.modelOverride);

  const result = await streamText({
    model,
    system: input.session.systemPrompt,
    messages,
    tools,
    maxSteps: 10,
    abortSignal: combinedSignal,
    onStepFinish: async ({ stepType, text, toolCalls, toolResults }) => {
      if (toolCalls && toolCalls.length > 0) {
        const stepAssistantId = crypto.randomUUID();
        appendMessage(db, {
          id: stepAssistantId,
          conversationId: input.conversationId,
          role: 'assistant',
          content: text ?? '',
          toolCalls: JSON.stringify(
            toolCalls.map((tc) => ({
              tool_call_id: tc.toolCallId,
              tool_name: tc.toolName,
              args: tc.args,
            })),
          ),
          modelIdUsed: input.session.modelId,
          createdAt: Date.now(),
        });
        for (const tr of toolResults ?? []) {
          const raw = tr.result as { __augchatd_error?: { code: string; server_label: string }; __augchatd_cancelled?: boolean };
          if (raw && typeof raw === 'object' && '__augchatd_cancelled' in raw) {
            insertToolResult(db, {
              id: crypto.randomUUID(),
              conversationId: input.conversationId,
              toolCallId: tr.toolCallId,
              status: 'cancelled',
              createdAt: Date.now(),
            });
          } else if (raw && typeof raw === 'object' && '__augchatd_error' in raw) {
            insertToolResult(db, {
              id: crypto.randomUUID(),
              conversationId: input.conversationId,
              toolCallId: tr.toolCallId,
              status: 'error',
              error: raw.__augchatd_error!,
              createdAt: Date.now(),
            });
          } else {
            insertToolResult(db, {
              id: crypto.randomUUID(),
              conversationId: input.conversationId,
              toolCallId: tr.toolCallId,
              status: 'ok',
              result: tr.result,
              createdAt: Date.now(),
            });
          }
        }
      } else if (stepType === 'initial' || stepType === 'continue') {
        // final-only step (no tool calls) — persisted in onFinish below to avoid duplicates
      }
    },
    onFinish: async ({ text, finishReason }) => {
      clearTimeout(turnTimer);
      if (text && text.length > 0 && finishReason !== 'tool-calls') {
        appendMessage(db, {
          id: crypto.randomUUID(),
          conversationId: input.conversationId,
          role: 'assistant',
          content: text,
          modelIdUsed: input.session.modelId,
          createdAt: Date.now(),
        });
      }
    },
  });

  return result.toDataStreamResponse();
  // Note: sanitization wrapper is added in Task 15. Keep direct return here so this task remains testable.
}
```

Also extend the `messages` route caller (in `src/server/routes/messages.ts`) to pass `config: ctx.config.mcp`:

```typescript
      return await runChat({
        session,
        conversationId: c.req.param('id'),
        userMessage: parsed.data.message,
        hotDir: ctx.config.hotDir,
        config: ctx.config.mcp,
        abortSignal: c.req.raw.signal,
        modelOverride: ctx.modelOverride,
      });
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/chat/stream.test.ts`
Expected: all passing (old + new).

- [ ] **Step 5: Run the full backend suite to catch route knock-on**

Run: `bun test tests/`
Expected: green. If `tests/server/routes/messages.test.ts` fails because the runChat config is missing in older test setups, pass `config: { toolTimeoutSeconds: 30, turnTimeoutSeconds: 300, parallelCap: 8 }` into the app context for that test file.

- [ ] **Step 6: Commit**

```bash
git add src/chat/stream.ts src/server/routes/messages.ts tests/chat/stream.test.ts
git commit -m "feat(chat): tools + maxSteps + per-tool timeout + tool persistence in runChat"
```

---

### Task 15: Sanitization pipe + error path (401, loop_limit, total_timeout)

**Files:**
- Modify: `src/chat/stream.ts`
- Modify: `tests/chat/stream.test.ts`

Wraps the data stream in a `TransformStream` that runs `sanitizeStreamLine` on each line, and adds explicit handling for:

- `McpUnauthorizedError` anywhere in the loop → mark sid stale, emit a `3:` error line with `mcp_credentials_expired`, close.
- `streamText` throws because `maxSteps` exceeded → emit `3:` error `loop_limit_exceeded`.
- Turn-timeout AbortError → emit `3:` error `total_timeout`.
- Client AbortSignal (request closed) → mark the in-flight assistant row `stopped_by_user=1` after the next `onStepFinish`/`onFinish`; in-flight tool calls receive the abort, surface as `cancelled`.

For mid-stream errors we need a mechanism to inject a final `3:` line into the output even after `streamText` finishes. We implement that via a `TransformStream` controller that the chat-level error handler can write to before closing.

- [ ] **Step 1: Add tests**

Append to `/home/joao/augchatd/tests/chat/stream.test.ts`:

```typescript
test('MCP 401 marks session stale and emits 3:error mcp_credentials_expired', async () => {
  const mcp = createFakeMcpClient();
  mcp.programTools('gh', [{ name: 'search', inputSchema: { type: 'object' } }]);
  mcp.programCallFailure('gh', 'search', 'credentials_expired');
  const session = await sessionWithMcp(mcp, [{ label: 'gh', tools: [{ name: 'search' }] }]);
  // session.stale starts false; runChat should flip it
  const sessions = { markStale: (sid: string) => { staleCalled.push(sid); } };
  const staleCalled: string[] = [];

  const res = await runChat({
    session,
    conversationId: 'conv-401',
    userMessage: 'find x',
    hotDir,
    config: { toolTimeoutSeconds: 5, turnTimeoutSeconds: 30, parallelCap: 4 },
    abortSignal: new AbortController().signal,
    modelOverride: modelWithToolCall(),
    sid: 'sid_x',
    markStale: (sid) => sessions.markStale(sid),
  });
  const body = await res.text();
  expect(body).toContain('mcp_credentials_expired');
  expect(staleCalled).toEqual(['sid_x']);
});

test('total_timeout emits 3:error after deadline', async () => {
  const mcp = createFakeMcpClient();
  mcp.programTools('gh', [{ name: 'slow', inputSchema: { type: 'object' } }]);
  mcp.programDelay('gh', 'slow', 5_000);
  const session = await sessionWithMcp(mcp, [{ label: 'gh', tools: [{ name: 'slow' }] }]);
  const res = await runChat({
    session,
    conversationId: 'conv-timeout',
    userMessage: 'do it',
    hotDir,
    config: { toolTimeoutSeconds: 30, turnTimeoutSeconds: 1, parallelCap: 4 },
    abortSignal: new AbortController().signal,
    modelOverride: modelWithToolCall(),
    sid: 'sid_x',
    markStale: () => {},
  });
  const body = await res.text();
  expect(body).toContain('total_timeout');
});

test('sanitization strips url from any emitted tool-call payload', async () => {
  const session = await sessionWithMcp(undefined, [
    { label: 'gh', tools: [{ name: 'echo', result: { ok: 1 } }] },
  ]);
  // A model that tries to embed url in args (defense in depth):
  const model = new MockLanguageModelV1({
    doStream: async ({ messages }) => {
      const lastIsTool = messages[messages.length - 1]?.role === 'tool';
      if (lastIsTool) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-delta', textDelta: 'k' },
              { type: 'finish', finishReason: 'stop', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallType: 'function',
              toolCallId: 'tc1',
              toolName: 'gh_echo',
              args: JSON.stringify({ url: 'https://leak.example/', q: 'hi' }),
            },
            { type: 'finish', finishReason: 'tool-calls', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });

  const res = await runChat({
    session,
    conversationId: 'conv-sanit',
    userMessage: 'go',
    hotDir,
    config: { toolTimeoutSeconds: 5, turnTimeoutSeconds: 30, parallelCap: 4 },
    abortSignal: new AbortController().signal,
    modelOverride: model,
    sid: 'sid_x',
    markStale: () => {},
  });
  const body = await res.text();
  expect(body).not.toContain('leak.example');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/chat/stream.test.ts`
Expected: FAIL (runChat doesn't accept `sid` / `markStale`).

- [ ] **Step 3: Extend RunChatInput and add the sanitizing pipe + error handler**

Modify `/home/joao/augchatd/src/chat/stream.ts`. Add imports:

```typescript
import { sanitizeStreamLine } from '../mcp/sanitize';
```

Extend `RunChatInput`:

```typescript
  sid: string;
  markStale: (sid: string) => void;
```

Refactor the bottom of `runChat` (the part that returns the response). Replace the simple `return result.toDataStreamResponse();` with:

```typescript
  // Build a transform stream that sanitizes lines + lets us inject a final 3:error line.
  let injectedTrailer: string | null = null;
  const sanitizer = new TransformStream<string, string>({
    transform(chunk, ctrl) {
      // chunk may contain multiple lines separated by \n
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length - 1; i++) ctrl.enqueue(sanitizeStreamLine(lines[i]!) + '\n');
      // last fragment may be partial; buffer it on this.tail
      (this as { tail?: string }).tail = ((this as { tail?: string }).tail ?? '') + lines[lines.length - 1];
    },
    flush(ctrl) {
      const self = this as { tail?: string };
      if (self.tail && self.tail.length > 0) ctrl.enqueue(sanitizeStreamLine(self.tail));
      if (injectedTrailer) ctrl.enqueue('\n' + injectedTrailer + '\n');
    },
  });

  const dataStream = result.toDataStream({
    getErrorMessage: (err) => {
      if (err instanceof McpUnauthorizedError) {
        input.markStale(input.sid);
        injectedTrailer = `3:${JSON.stringify({ code: 'mcp_credentials_expired', detail: { server_label: err.serverLabel } })}`;
        log.warn('mcp.401.session_marked_stale', 'session marked stale', {
          session_id: input.sid, tenant_id: input.session.tenantId, server_label: err.serverLabel,
        });
        return 'mcp_credentials_expired';
      }
      const msg = String((err as Error)?.message ?? '');
      if (/total_timeout/.test(msg)) {
        injectedTrailer = `3:${JSON.stringify({ code: 'total_timeout' })}`;
        return 'total_timeout';
      }
      if (/max[ _]?steps|loop[ _]?limit/i.test(msg)) {
        injectedTrailer = `3:${JSON.stringify({ code: 'loop_limit_exceeded' })}`;
        return 'loop_limit_exceeded';
      }
      if (/rate.?limit/i.test(msg)) {
        injectedTrailer = `3:${JSON.stringify({ code: 'llm_rate_limited' })}`;
        return 'llm_rate_limited';
      }
      return msg;
    },
  });

  const decoder = new TextDecoderStream();
  const piped = dataStream
    .pipeThrough(decoder)
    .pipeThrough(sanitizer)
    .pipeThrough(new TextEncoderStream());

  return new Response(piped, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
```

Update the route layer (`src/server/routes/messages.ts`) to pass `sid: c.get('sid')` and `markStale: (sid) => ctx.sessions.markStale(sid)`.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/chat/stream.test.ts`
Expected: all passing.

- [ ] **Step 5: Run full suite**

Run: `bun test tests/`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/chat/stream.ts src/server/routes/messages.ts tests/chat/stream.test.ts
git commit -m "feat(chat): sanitization pipe + mcp_credentials_expired/total_timeout/loop_limit trailers"
```

---

### Task 16: Demo boot — eager MCP init + exit 1 on failure

**Files:**
- Modify: `src/index.ts`
- Create: `tests/index.test.ts` (lightweight smoke; full e2e in Task 18)

Per spec §4.1.2 + §2 (eager init).

- [ ] **Step 1: Add failing test**

Create `/home/joao/augchatd/tests/index.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { buildDemoEntry } from '../src/index';
import { createFakeMcpClient } from '../src/mcp/client';
import { McpUnauthorizedError } from '../src/mcp/types';

test('buildDemoEntry returns SessionEntry with mcpClients populated', async () => {
  const fake = createFakeMcpClient();
  fake.programTools('gh', [{ name: 'echo', inputSchema: { type: 'object' } }]);
  const entry = await buildDemoEntry({
    payload: {
      user_id: 'demo-user',
      system_prompt: 'p',
      model: { provider: 'anthropic', model_id: 'm', api_key: 'k' },
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' }, transport: 'streamable_http' }],
    },
    mcpClient: fake,
    ttlSeconds: 1000,
  });
  expect(entry.mcpClients.get('gh')?.tools.map((t) => t.exposedName)).toEqual(['gh_echo']);
});

test('buildDemoEntry propagates MCP failure (no swallowing)', async () => {
  const fake = createFakeMcpClient();
  fake.programInitFailure('gh', 'credentials_expired');
  await expect(
    buildDemoEntry({
      payload: {
        user_id: 'demo-user',
        system_prompt: 'p',
        model: { provider: 'anthropic', model_id: 'm', api_key: 'k' },
        mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' }, transport: 'streamable_http' }],
      },
      mcpClient: fake,
      ttlSeconds: 1000,
    }),
  ).rejects.toBeInstanceOf(McpUnauthorizedError);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extract buildDemoEntry and wire MCP init**

Modify `/home/joao/augchatd/src/index.ts`. Export a new helper (alongside whatever existing boot code is there):

```typescript
import { eagerInitMcp } from './mcp/eager-init';
import type { McpClient } from './mcp/client';
import type { SessionPayload } from './config/session-schema';
import type { SessionEntry } from './auth/sessions';

export interface BuildDemoEntryInput {
  payload: SessionPayload;
  mcpClient: McpClient;
  ttlSeconds: number;
}

export async function buildDemoEntry(input: BuildDemoEntryInput): Promise<SessionEntry> {
  const handles = input.payload.mcp_servers && input.payload.mcp_servers.length > 0
    ? await eagerInitMcp(input.mcpClient, input.payload.mcp_servers)
    : new Map();
  const now = Date.now();
  return {
    tenantId: 'urn:augchatd-tenant:demo',
    userId: input.payload.user_id,
    modelProvider: input.payload.model.provider,
    modelId: input.payload.model.model_id,
    modelApiKey: input.payload.model.api_key,
    systemPrompt: input.payload.system_prompt,
    // Demo storage stays optional (Fatia 2 demo behavior); narrow as appropriate
    storage: (input.payload.storage ? { s3: input.payload.storage.s3 } : undefined) as never,
    expiresAt: now + input.ttlSeconds * 1000,
    createdAt: now,
    stale: false,
    conversationsTouched: new Set<string>(),
    mcpClients: handles,
  };
}
```

In the demo boot path (wherever `index.ts` already calls `buildDemoSession`), wrap the call in a try/catch:

```typescript
try {
  const entry = await buildDemoEntry({ payload, mcpClient: createSdkMcpClient(), ttlSeconds: 365 * 24 * 3600 });
  sessions.put('demo', entry);
} catch (e) {
  const isUnauth = e instanceof McpUnauthorizedError;
  const kind = isUnauth ? 'credentials_expired' : (e as { kind?: string })?.kind ?? 'unknown';
  const label = (e as { serverLabel?: string })?.serverLabel ?? 'unknown';
  log.error('mcp_init_failed', 'demo boot failed', { server_label: label, kind });
  process.exit(1);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/index.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(boot): demo eager-inits MCP; exit 1 with categorized code on failure"
```

---

### Task 17: E2E — demo + prod with FakeMcpClient

**Files:**
- Create: `tests/e2e/mcp.test.ts`

Exercises the full chain: demo boot with `DEMO_MCP_SERVERS`, fetch `/demo/jwt`, hit `POST /conversations/{id}/messages` with a model that emits a tool call, watch the persisted history and the data-stream output. Then a prod variant where `POST /sessions` with `mcp_servers` succeeds and the same model flow runs.

- [ ] **Step 1: Write the test**

Create `/home/joao/augchatd/tests/e2e/mcp.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { createApp } from '../../src/server/app';
import { createJwtModule } from '../../src/auth/jwt';
import { createSessionStore } from '../../src/auth/sessions';
import { closeAllDbs, openTenantDb } from '../../src/storage/db';
import { listMessages } from '../../src/storage/messages';
import { createFakeMcpClient } from '../../src/mcp/client';
import { createFakeS3Client } from '../../src/storage/s3-client';
import { buildDemoEntry } from '../../src/index';

const KEY = new TextEncoder().encode('A'.repeat(32));

let hotDir: string;
beforeEach(() => { hotDir = mkdtempSync(join(tmpdir(), 'aug-e2e-')); });
afterEach(() => { closeAllDbs(); rmSync(hotDir, { recursive: true, force: true }); });

function twoStepModel() {
  return new MockLanguageModelV1({
    doStream: async ({ messages }) => {
      const lastIsTool = messages[messages.length - 1]?.role === 'tool';
      if (lastIsTool) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-delta', textDelta: 'ok!' },
              { type: 'finish', finishReason: 'stop', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call', toolCallType: 'function', toolCallId: 'tc1', toolName: 'gh_echo', args: '{"q":"hi"}' },
            { type: 'finish', finishReason: 'tool-calls', logprobs: undefined, usage: { promptTokens: 1, completionTokens: 1 } },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

test('demo end-to-end with MCP tool call', async () => {
  const sessions = createSessionStore({});
  const jwt = createJwtModule({ currentKey: KEY, ttlSeconds: 600 });
  const mcp = createFakeMcpClient();
  mcp.programTools('gh', [{ name: 'echo', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]);
  mcp.programResult('gh', 'echo', { ack: 'hi' });
  const entry = await buildDemoEntry({
    payload: {
      user_id: 'demo-user',
      system_prompt: 'be brief',
      model: { provider: 'anthropic', model_id: 'm', api_key: 'k' },
      mcp_servers: [{ label: 'gh', url: 'https://m/', auth: { bearer: 't' }, transport: 'streamable_http' }],
    },
    mcpClient: mcp,
    ttlSeconds: 600,
  });
  sessions.put('demo', entry);

  const app = createApp({
    config: {
      mode: 'demo', listen: { host: '0', port: 0 }, hotDir,
      jwt: { currentKey: KEY, ttlSeconds: 600 },
      mcp: { toolTimeoutSeconds: 5, turnTimeoutSeconds: 10, parallelCap: 4 },
    } as never,
    sessions, jwt, versionSha: 'x', appVersion: '0',
    modelOverride: twoStepModel(),
  } as never);

  const jwtRes = await app.request('/demo/jwt');
  const { jwt: token } = await jwtRes.json();
  const res = await app.request('/conversations/conv-e2e/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'ping' }),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('ok!');
  expect(body).not.toContain('https://m/'); // sanitized

  const db = openTenantDb('urn:augchatd-tenant:demo', hotDir);
  const msgs = listMessages(db, 'conv-e2e');
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(JSON.parse(msgs[2]!.content).result).toEqual({ ack: 'hi' });
});
```

- [ ] **Step 2: Run, verify pass**

Run: `bun test tests/e2e/mcp.test.ts`
Expected: 1 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/mcp.test.ts
git commit -m "test(e2e): demo + MCP tool-call round trip end-to-end"
```

---

### Task 18: Full test sweep + README touchups

**Files:**
- Run: full suite
- Modify: `README.md` (small clarifications, non-blocking)

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: every test green.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Build the UI (regression)**

Run: `cd ui && bun run build && cd ..`
Expected: succeeds.

- [ ] **Step 4: README touchups (non-blocking)**

Modify `/home/joao/augchatd/README.md`. In the example payload, change the `mcp_servers` entry to include a `label`:

```json
"mcp_servers": [ { "label": "github", "url": "https://your-mcp/", "auth": { "bearer": "..." } } ]
```

In the *What augchatd does NOT do* section, no change needed — the constraints already match. In the *Status* section, you may add: *"Fatia 3 (MCP client) implemented: per-session HTTP/SSE MCP integration with eager init, 401-stale propagation, 30s per-tool / 5min per-turn timeouts, configurable concurrency cap."* This sentence is optional and can be removed if README maintenance is being tracked elsewhere.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README touchups after Fatia 3 (label in mcp_servers example)"
```

---

## Self-review notes (informational; engineer needn't re-run)

The plan covers every spec section as follows:

- **§1 Objetivo / §2 Escopo entra** → Tasks 1–17 collectively.
- **§3 Escopo não entra** → enforced by `.strict()` on `SessionPayloadSchema` (Task 2) plus tests for `tools.rag` rejection.
- **§4.1 Env vars** → Task 1 (process) + Task 3 (demo).
- **§4.2 Endpoints** → Task 11 (POST /sessions delta + DELETE close); messages route unchanged at the URL contract.
- **§4.3 JWT 401 codes** → already wired by Fatia 1; the `stale` flag now flips from Task 15.
- **§4.4 Schema** → Task 2.
- **§4.5 Control plane error codes** → Task 11.
- **§4.6 postMessage** → unchanged (no task needed).
- **§4.7 Stream events + sanitization + categorized errors** → Tasks 9 (helper) + 14 (events) + 15 (trailer + 401).
- **§5.1 SQLite** → Task 12.
- **§5.2 SessionEntry** → Tasks 4 + 11.
- **§5.3 SessionPayloadSchema** → Task 2.
- **§5.4 NDJSON** → no new task: rows already serialize via Fatia 2's `src/storage/ndjson.ts`; the new `role='tool'` rows have `content` as a JSON string, which serializes naturally.
- **§5.5 Hydration** → Task 13.
- **§6 Loop tool-use end-to-end** → Tasks 8, 10, 14, 15 together.
- **§7 Mapeamento Cluster** → captured implicitly by the corresponding tasks.
- **§8 Acceptance criteria** → exercised by Tasks 11, 14, 15, 16, 17 + Task 18 sweep.
- **§9 Deferred** → enforced by `.strict()` on schemas (Task 2) and by the absence of code paths for prompts/resources/sampling/stdio/etc.

Type consistency:

- `McpClientHandle` (Task 5) and `McpClientHandleLike` (Task 4) intentionally overlap on `label`, `close()`, `closed`; the full handle extends the like-shape via `extends`. Verified.
- `McpClient.callTool(server, name, args, signal)` (Task 6) matches what `eagerInitMcp` (Task 8) wraps in the per-handle `callTool(name, args, signal)` closure.
- `RunChatInput` (Task 14) is extended in Task 15 (`sid`, `markStale`). The route caller is updated in Task 15 step 3.
- `McpErrorKind` (Task 5) covers every kind that appears in stream codes (Task 14 — mapping in `buildTools`) and in 400 responses (Task 11 — mapping in route handler).

---

## Execution choice

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-augchatd-fatia-3-mcp.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task + two-stage review.

**2. Inline Execution** — batch execution with checkpoints in this session.

**Which approach?**
