# augchatd — Fatia 2 (production mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn augchatd into a working production daemon: mTLS-authenticated control plane on a separate port (`POST /sessions`, `DELETE /sessions/{id}`), multi-tenant SQLite with lazy lifecycle, per-conversation NDJSON flush to S3 cold storage, boot recovery for pending flushes, and graceful shutdown with synchronous drain. Demo mode (Fatia 1) keeps working unchanged in the same binary.

**Architecture:** Same Bun + Hono process as Fatia 1, but now spins **two** `Bun.serve` instances — one mTLS-required for control plane, one TLS-optional for data plane (UI + JWT). `POST /sessions` validates payload, runs an S3 write+read+delete smoke test, mints the JWT, and registers a session entry. Sessions accumulate `conversationsTouched`; on eviction (TTL, DELETE, or shutdown) every touched conversation is enqueued in a singleton flush queue. The queue serializes a conversation's messages to NDJSON and PUTs `meta.json` then `messages.ndjson` to `<bucket>/<prefix><tenant>/<user>/<conv>/`. A periodic GC pass deletes hot rows that are confirmed in cold and older than `AUGCHATD_GC_DELAY_SECONDS`. Boot recovery scans `AUGCHATD_HOT_DIR` for orphaned tenants with unflushed rows and registers them as pending — waiting for a future `POST /sessions` to supply the S3 credentials. Demo mode continues to open only the data port.

**Tech Stack:** Bun ≥ 1.1.43 (adds `Bun.S3Client`) · Hono 4 · Vercel AI SDK (unchanged) · `jose` (JWT, unchanged) · `zod` (schemas, unchanged) · `node:tls` peer cert inspection via Bun's TLS connection metadata. **No `@aws-sdk/client-s3` dependency** — Bun's native S3Client covers the PUT/GET/DELETE we need (only two known object keys per conversation, so no `ListObjectsV2` required).

**Source of truth for architectural decisions:** `docs/superpowers/specs/2026-05-22-augchatd-fatia-2-producao-spec.md` (this fatia), `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md` (transversal). Tasks reference spec sections (§N.M) and cluster letters (A–I).

**Pre-requisite:** Fatia 1 implemented and merged (plan: `docs/superpowers/plans/2026-05-21-augchatd-fatia-1-mvp-demo.md`). This plan extends that codebase; without it nothing here makes sense.

---

## File Structure

New files (created by this plan):

```
src/
├── config/
│   ├── env.ts                          # MODIFIED: rename LISTEN→LISTEN_DATA, add prod+timing vars
│   ├── session-schema.ts               # MODIFIED: structured storage.s3, .strict()
│   └── demo.ts                         # MODIFIED: DEMO_STORAGE_S3 now JSON
├── auth/
│   ├── sessions.ts                     # MODIFIED: SessionEntry gains createdAt + conversationsTouched + onEvict hook
│   └── san-uri.ts                      # NEW: extract single SAN URI from peer cert
├── storage/
│   ├── tenant-registry.ts              # NEW: per-tenant TenantHandle with lazy open + idle close
│   ├── s3-client.ts                    # NEW: S3Client interface + Bun-backed impl + fake for tests
│   ├── ndjson.ts                       # NEW: serialize messages + meta to NDJSON / JSON canonical
│   ├── flush-queue.ts                  # NEW: singleton flush coordinator (schedule, cancel, retry)
│   ├── gc.ts                           # NEW: periodic delete of rows with flushed_at < now - DELAY
│   ├── recovery.ts                     # NEW: boot scan of hot dir for pending flushes
│   ├── hydration.ts                    # NEW: cold→hot pull on missing conversation
│   └── cold-delete.ts                  # NEW: DELETE conversation prefix in S3
├── server/
│   ├── shutdown.ts                     # NEW: graceful shutdown coordinator
│   ├── middleware/
│   │   ├── mtls.ts                     # NEW: extract tenant_id from peer cert, populate Hono var
│   │   └── shutting-down.ts            # NEW: 503 if shutdown started
│   └── routes/
│       ├── sessions.ts                 # NEW: POST/DELETE /sessions (control plane only)
│       ├── conversations.ts            # MODIFIED: DELETE also enqueues S3 prefix delete
│       └── messages.ts                 # MODIFIED: hydrate from cold if conv not hot
└── index.ts                            # MODIFIED: prod boot path, two-port serve, signal handlers

tests/
├── auth/san-uri.test.ts                # NEW
├── storage/tenant-registry.test.ts     # NEW
├── storage/s3-client.test.ts           # NEW
├── storage/ndjson.test.ts              # NEW
├── storage/flush-queue.test.ts         # NEW
├── storage/gc.test.ts                  # NEW
├── storage/recovery.test.ts            # NEW
├── storage/hydration.test.ts           # NEW
├── storage/cold-delete.test.ts         # NEW
├── server/middleware/mtls.test.ts      # NEW
├── server/middleware/shutting-down.test.ts  # NEW
├── server/routes/sessions.test.ts      # NEW
├── server/shutdown.test.ts             # NEW
├── e2e/prod.test.ts                    # NEW: mTLS + MinIO end-to-end
└── fixtures/
    └── mtls/                           # NEW: pre-generated test CA + server + client certs
        ├── ca.crt
        ├── ca.key
        ├── server.crt
        ├── server.key
        ├── client-acme.crt              # SAN URI urn:augchatd-tenant:acme
        ├── client-acme.key
        ├── client-beta.crt              # SAN URI urn:augchatd-tenant:beta
        ├── client-beta.key
        ├── client-no-san.crt            # zero SAN URIs
        ├── client-no-san.key
        ├── client-multi-san.crt         # two SAN URIs
        └── client-multi-san.key

scripts/
└── gen-test-certs.sh                   # NEW: regenerate test fixtures (committed certs are deterministic-ish; script is for refreshing)

docker-compose.test.yml                 # NEW: MinIO for e2e

Dockerfile                              # MODIFIED: expose 8443; document mount points for cert/key/CA
```

---

## Conventions

Inherit all from Fatia 1 (`docs/superpowers/plans/2026-05-21-augchatd-fatia-1-mvp-demo.md` § Conventions). Adds:

- **mTLS test certs are committed to the repo under `tests/fixtures/mtls/`.** They are test-only — no real CA, no real key material. The generation script (`scripts/gen-test-certs.sh`) lets anyone regenerate them deterministically.
- **All S3 access goes through `src/storage/s3-client.ts`'s `S3Client` interface.** Tests use the in-memory fake; production wires `BunS3Client`. Never import `Bun.S3Client` directly outside `s3-client.ts`.
- **Time injection.** Any module that schedules a timer takes a `now(): number` and `setTimeout`/`clearTimeout` injection (or uses `Bun.sleep`-style abstraction). Tests use a `FakeClock`. This keeps the test suite deterministic and fast.
- **Error categorization for S3 failures** maps SDK kinds to spec codes (§4.4): `timeout`, `auth` (401/403), `not_found` (404), `forbidden` (403 on PUT), `server_error` (5xx), `unknown`. Each helper that talks to S3 returns or throws an error carrying one of these kinds.
- **Spec section references** use the form `§4.2.1` for the new spec and `§A.4` for the arch doc. Both are sources of truth; if they conflict, this fatia's spec wins.

---

### Task 1: Env vars — rename `AUGCHATD_LISTEN`, add prod + timing vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `tests/config/env.test.ts`

Per spec §4.1.1: rename `AUGCHATD_LISTEN` → `AUGCHATD_LISTEN_DATA`. Add: `AUGCHATD_LISTEN_CONTROL`, `AUGCHATD_TLS_CERT_FILE`, `AUGCHATD_TLS_KEY_FILE`, `AUGCHATD_CLIENT_CA_FILE`, `AUGCHATD_DATA_TLS_CERT_FILE`, `AUGCHATD_DATA_TLS_KEY_FILE`, `AUGCHATD_FLUSH_IDLE_SECONDS`, `AUGCHATD_TENANT_IDLE_CLOSE_SECONDS`, `AUGCHATD_GC_DELAY_SECONDS`, `AUGCHATD_SHUTDOWN_DEADLINE_SECONDS`, `AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS`. In `mode=prod`, the three mTLS vars are required.

- [ ] **Step 1: Update env tests**

Replace `/home/joao/augchatd/tests/config/env.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { parseEnv } from '../../src/config/env';

const KEY32 = (c: string) => Buffer.from(c.repeat(32)).toString('base64');

const baseDemoEnv = {
  AUGCHATD_MODE: 'demo',
  AUGCHATD_LISTEN_DATA: '0.0.0.0:8080',
  AUGCHATD_HOT_DIR: '/tmp/aug-hot',
  AUGCHATD_JWT_SIGNING_KEY_CURRENT: KEY32('a'),
};

const baseProdEnv = {
  ...baseDemoEnv,
  AUGCHATD_MODE: 'prod',
  AUGCHATD_LISTEN_CONTROL: '0.0.0.0:8443',
  AUGCHATD_TLS_CERT_FILE: '/etc/tls/server.crt',
  AUGCHATD_TLS_KEY_FILE: '/etc/tls/server.key',
  AUGCHATD_CLIENT_CA_FILE: '/etc/tls/ca.crt',
};

test('demo env parses with defaults for new timing vars', () => {
  const cfg = parseEnv(baseDemoEnv);
  expect(cfg.mode).toBe('demo');
  expect(cfg.listenData).toEqual({ host: '0.0.0.0', port: 8080 });
  expect(cfg.listenControl).toBeUndefined();
  expect(cfg.tls).toBeUndefined();
  expect(cfg.flushIdleSeconds).toBe(300);
  expect(cfg.tenantIdleCloseSeconds).toBe(1800);
  expect(cfg.gcDelaySeconds).toBe(60);
  expect(cfg.shutdownDeadlineSeconds).toBe(30);
  expect(cfg.flushBackoffCapSeconds).toBe(300);
});

test('prod env requires control listen + mTLS material', () => {
  const cfg = parseEnv(baseProdEnv);
  expect(cfg.mode).toBe('prod');
  expect(cfg.listenControl).toEqual({ host: '0.0.0.0', port: 8443 });
  expect(cfg.tls?.certFile).toBe('/etc/tls/server.crt');
  expect(cfg.tls?.keyFile).toBe('/etc/tls/server.key');
  expect(cfg.tls?.clientCaFile).toBe('/etc/tls/ca.crt');
});

test('prod env without LISTEN_CONTROL throws with clear name', () => {
  const env = { ...baseProdEnv } as Record<string, string>;
  delete env.AUGCHATD_LISTEN_CONTROL;
  expect(() => parseEnv(env)).toThrow(/AUGCHATD_LISTEN_CONTROL/);
});

test('prod env without TLS_CERT_FILE throws', () => {
  const env = { ...baseProdEnv } as Record<string, string>;
  delete env.AUGCHATD_TLS_CERT_FILE;
  expect(() => parseEnv(env)).toThrow(/AUGCHATD_TLS_CERT_FILE/);
});

test('demo env ignores LISTEN_CONTROL but does not throw', () => {
  const cfg = parseEnv({ ...baseDemoEnv, AUGCHATD_LISTEN_CONTROL: '0.0.0.0:8443' });
  expect(cfg.listenControl).toBeUndefined();
});

test('data plane TLS is optional and parses when both files set', () => {
  const cfg = parseEnv({
    ...baseDemoEnv,
    AUGCHATD_DATA_TLS_CERT_FILE: '/etc/tls/data.crt',
    AUGCHATD_DATA_TLS_KEY_FILE: '/etc/tls/data.key',
  });
  expect(cfg.dataTls).toEqual({ certFile: '/etc/tls/data.crt', keyFile: '/etc/tls/data.key' });
});

test('data plane TLS partial config throws', () => {
  expect(() =>
    parseEnv({ ...baseDemoEnv, AUGCHATD_DATA_TLS_CERT_FILE: '/etc/tls/data.crt' }),
  ).toThrow(/AUGCHATD_DATA_TLS_KEY_FILE/);
});

test('timing vars override defaults', () => {
  const cfg = parseEnv({
    ...baseDemoEnv,
    AUGCHATD_FLUSH_IDLE_SECONDS: '120',
    AUGCHATD_TENANT_IDLE_CLOSE_SECONDS: '900',
    AUGCHATD_GC_DELAY_SECONDS: '30',
    AUGCHATD_SHUTDOWN_DEADLINE_SECONDS: '60',
    AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS: '60',
  });
  expect(cfg.flushIdleSeconds).toBe(120);
  expect(cfg.tenantIdleCloseSeconds).toBe(900);
  expect(cfg.gcDelaySeconds).toBe(30);
  expect(cfg.shutdownDeadlineSeconds).toBe(60);
  expect(cfg.flushBackoffCapSeconds).toBe(60);
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `bun test tests/config/env.test.ts`
Expected: FAIL on new field names (`listenData`, `listenControl`, `tls`, `flushIdleSeconds`, etc.).

- [ ] **Step 3: Update `src/config/env.ts`**

Replace `/home/joao/augchatd/src/config/env.ts`:

```typescript
import { z } from 'zod';

const ListenSchema = z
  .string()
  .regex(/^[^:]+:\d+$/, 'must be host:port')
  .transform((s) => {
    const [host, portStr] = s.split(':');
    return { host: host!, port: Number(portStr!) };
  });

const Base64Key = z
  .string()
  .min(1)
  .transform((s) => Buffer.from(s, 'base64'))
  .refine((b) => b.byteLength >= 32, { message: 'JWT signing key must be at least 32 bytes' });

const RawEnvSchema = z.object({
  AUGCHATD_MODE: z.enum(['demo', 'prod']).default('demo'),
  AUGCHATD_LISTEN_DATA: ListenSchema.default('0.0.0.0:8080' as never),
  AUGCHATD_LISTEN_CONTROL: ListenSchema.optional(),
  AUGCHATD_TLS_CERT_FILE: z.string().min(1).optional(),
  AUGCHATD_TLS_KEY_FILE: z.string().min(1).optional(),
  AUGCHATD_CLIENT_CA_FILE: z.string().min(1).optional(),
  AUGCHATD_DATA_TLS_CERT_FILE: z.string().min(1).optional(),
  AUGCHATD_DATA_TLS_KEY_FILE: z.string().min(1).optional(),
  AUGCHATD_HOT_DIR: z.string().default('/var/lib/augchatd/hot'),
  AUGCHATD_JWT_SIGNING_KEY_CURRENT: Base64Key,
  AUGCHATD_JWT_SIGNING_KEY_PREVIOUS: Base64Key.optional(),
  AUGCHATD_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUGCHATD_FLUSH_IDLE_SECONDS: z.coerce.number().int().positive().default(300),
  AUGCHATD_TENANT_IDLE_CLOSE_SECONDS: z.coerce.number().int().positive().default(1800),
  AUGCHATD_GC_DELAY_SECONDS: z.coerce.number().int().positive().default(60),
  AUGCHATD_SHUTDOWN_DEADLINE_SECONDS: z.coerce.number().int().positive().default(30),
  AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS: z.coerce.number().int().positive().default(300),
  AUGCHATD_UI_DIR: z.string().optional(),
  AUGCHATD_VERSION_SHA: z.string().default('dev'),
});

export interface ProcessConfig {
  mode: 'demo' | 'prod';
  listenData: { host: string; port: number };
  listenControl?: { host: string; port: number };
  tls?: { certFile: string; keyFile: string; clientCaFile: string };
  dataTls?: { certFile: string; keyFile: string };
  hotDir: string;
  uiDir?: string;
  versionSha: string;
  jwt: { currentKey: Uint8Array; previousKey?: Uint8Array; ttlSeconds: number };
  flushIdleSeconds: number;
  tenantIdleCloseSeconds: number;
  gcDelaySeconds: number;
  shutdownDeadlineSeconds: number;
  flushBackoffCapSeconds: number;
}

function required(name: string, val: string | undefined): string {
  if (!val) throw new Error(`config_invalid: ${name} missing`);
  return val;
}

export function parseEnv(env: Record<string, string | undefined>): ProcessConfig {
  const parsed = RawEnvSchema.parse(env);

  const cfg: ProcessConfig = {
    mode: parsed.AUGCHATD_MODE,
    listenData: parsed.AUGCHATD_LISTEN_DATA,
    listenControl: undefined,
    hotDir: parsed.AUGCHATD_HOT_DIR,
    uiDir: parsed.AUGCHATD_UI_DIR,
    versionSha: parsed.AUGCHATD_VERSION_SHA,
    jwt: {
      currentKey: new Uint8Array(parsed.AUGCHATD_JWT_SIGNING_KEY_CURRENT),
      previousKey: parsed.AUGCHATD_JWT_SIGNING_KEY_PREVIOUS
        ? new Uint8Array(parsed.AUGCHATD_JWT_SIGNING_KEY_PREVIOUS)
        : undefined,
      ttlSeconds: parsed.AUGCHATD_JWT_TTL_SECONDS,
    },
    flushIdleSeconds: parsed.AUGCHATD_FLUSH_IDLE_SECONDS,
    tenantIdleCloseSeconds: parsed.AUGCHATD_TENANT_IDLE_CLOSE_SECONDS,
    gcDelaySeconds: parsed.AUGCHATD_GC_DELAY_SECONDS,
    shutdownDeadlineSeconds: parsed.AUGCHATD_SHUTDOWN_DEADLINE_SECONDS,
    flushBackoffCapSeconds: parsed.AUGCHATD_FLUSH_BACKOFF_CAP_SECONDS,
  };

  if (cfg.mode === 'prod') {
    cfg.listenControl = parsed.AUGCHATD_LISTEN_CONTROL ??
      (() => { throw new Error('config_invalid: AUGCHATD_LISTEN_CONTROL missing'); })();
    cfg.tls = {
      certFile: required('AUGCHATD_TLS_CERT_FILE', parsed.AUGCHATD_TLS_CERT_FILE),
      keyFile: required('AUGCHATD_TLS_KEY_FILE', parsed.AUGCHATD_TLS_KEY_FILE),
      clientCaFile: required('AUGCHATD_CLIENT_CA_FILE', parsed.AUGCHATD_CLIENT_CA_FILE),
    };
  }

  const dataCert = parsed.AUGCHATD_DATA_TLS_CERT_FILE;
  const dataKey = parsed.AUGCHATD_DATA_TLS_KEY_FILE;
  if (dataCert || dataKey) {
    if (!dataCert) throw new Error('config_invalid: AUGCHATD_DATA_TLS_CERT_FILE missing (key set)');
    if (!dataKey) throw new Error('config_invalid: AUGCHATD_DATA_TLS_KEY_FILE missing (cert set)');
    cfg.dataTls = { certFile: dataCert, keyFile: dataKey };
  }

  return cfg;
}
```

- [ ] **Step 4: Update Fatia 1 callers referencing the old `listen` field**

Find every reference to `cfg.listen` in source and rename to `cfg.listenData`. Likely in `src/index.ts` only.

Run: `grep -rn "config\.listen\b\|cfg\.listen\b\|\.listen\b" src/`

For each occurrence in non-test source, change `.listen` → `.listenData`.

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/config/env.test.ts`
Expected: 8 passing.

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts src/index.ts
git commit -m "feat(config): rename LISTEN→LISTEN_DATA; add prod mTLS + timing env vars"
```

---

### Task 2: SessionPayloadSchema — structured `storage.s3`, `.strict()`

**Files:**
- Modify: `src/config/session-schema.ts`
- Modify: `tests/config/session-schema.test.ts`

Per spec §5.3: `storage.s3` becomes an object `{bucket, prefix?, region, endpoint?, access_key_id, secret_access_key, force_path_style?}`. Schema is `.strict()` at every level — `mcp_servers` / `tools.rag` → throws.

- [ ] **Step 1: Update tests**

Replace `/home/joao/augchatd/tests/config/session-schema.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { SessionPayloadSchema, DemoSessionPayloadSchema } from '../../src/config/session-schema';

const baseValid = {
  user_id: 'u',
  model: { provider: 'anthropic', model_id: 'm', api_key: 'k' },
  storage: {
    s3: {
      bucket: 'b',
      region: 'us-east-1',
      access_key_id: 'AKIA',
      secret_access_key: 'SECRET',
    },
  },
};

test('prod schema: minimal payload parses', () => {
  const parsed = SessionPayloadSchema.parse(baseValid);
  expect(parsed.storage.s3.bucket).toBe('b');
  expect(parsed.storage.s3.prefix).toBe('');
  expect(parsed.storage.s3.force_path_style).toBe(false);
});

test('prod schema: storage required', () => {
  const { storage: _, ...withoutStorage } = baseValid;
  expect(() => SessionPayloadSchema.parse(withoutStorage)).toThrow();
});

test('prod schema: rejects mcp_servers (strict)', () => {
  expect(() =>
    SessionPayloadSchema.parse({ ...baseValid, mcp_servers: [{ url: 'x' }] }),
  ).toThrow();
});

test('prod schema: rejects tools.rag (strict)', () => {
  expect(() =>
    SessionPayloadSchema.parse({ ...baseValid, tools: { rag: { backend: 'opensearch' } } }),
  ).toThrow();
});

test('prod schema: rejects unknown nested field on storage.s3', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...baseValid,
      storage: { s3: { ...baseValid.storage.s3, secret_key: 'oops' } },
    }),
  ).toThrow();
});

test('prod schema: endpoint must be a URL', () => {
  expect(() =>
    SessionPayloadSchema.parse({
      ...baseValid,
      storage: { s3: { ...baseValid.storage.s3, endpoint: 'not-a-url' } },
    }),
  ).toThrow();
});

test('demo schema: storage optional', () => {
  const { storage: _, ...withoutStorage } = baseValid;
  const parsed = DemoSessionPayloadSchema.parse(withoutStorage);
  expect(parsed.storage).toBeUndefined();
});

test('demo schema: still rejects mcp_servers', () => {
  expect(() =>
    DemoSessionPayloadSchema.parse({ ...baseValid, mcp_servers: [] }),
  ).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/session-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement schema**

Replace `/home/joao/augchatd/src/config/session-schema.ts`:

```typescript
import { z } from 'zod';

const ModelSchema = z.object({
  provider: z.enum(['anthropic']),
  model_id: z.string().min(1),
  api_key: z.string().min(1),
}).strict();

const S3Schema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().default(''),
  region: z.string().min(1),
  endpoint: z.string().url().optional(),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  force_path_style: z.boolean().default(false),
}).strict();

const StorageSchema = z.object({
  s3: S3Schema,
}).strict();

export const SessionPayloadSchema = z.object({
  user_id: z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model: ModelSchema,
  storage: StorageSchema,
}).strict();

export const DemoSessionPayloadSchema = z.object({
  user_id: z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model: ModelSchema,
  storage: StorageSchema.optional(),
}).strict();

export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
export type DemoSessionPayload = z.infer<typeof DemoSessionPayloadSchema>;
export type S3Config = z.infer<typeof S3Schema>;
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/session-schema.test.ts`
Expected: 8 passing.

Run: `bunx tsc --noEmit`
Expected: type errors at any Fatia 1 site that accessed `payload.storage.s3` as a string. Fix those by replacing with `payload.storage.s3.bucket` (etc) wherever needed. If only the demo path used `storage.s3`, leave for Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/config/session-schema.ts tests/config/session-schema.test.ts
git commit -m "feat(config): structured storage.s3 + strict SessionPayloadSchema"
```

---

### Task 3: Demo config builder — DEMO_STORAGE_S3 as JSON, optional

**Files:**
- Modify: `src/config/demo.ts`
- Modify: `tests/config/demo.test.ts`

Per spec §5.3 final bullet: `DEMO_STORAGE_S3` is now the JSON form of the structured `s3` object, not the `s3://...` string. Optional. Demo uses `DemoSessionPayloadSchema`.

- [ ] **Step 1: Update tests**

Replace `/home/joao/augchatd/tests/config/demo.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { buildDemoSession } from '../../src/config/demo';

const baseEnv = {
  DEMO_MODEL_PROVIDER: 'anthropic',
  DEMO_MODEL_ID: 'claude-opus-4-7',
  DEMO_MODEL_API_KEY: 'sk-ant-test',
  DEMO_SYSTEM_PROMPT: 'Be brief.',
};

test('builds valid session from minimal demo env, storage omitted', () => {
  const sess = buildDemoSession(baseEnv);
  expect(sess.user_id).toBe('demo-user');
  expect(sess.model.api_key).toBe('sk-ant-test');
  expect(sess.storage).toBeUndefined();
});

test('DEMO_STORAGE_S3 parsed as JSON object', () => {
  const sess = buildDemoSession({
    ...baseEnv,
    DEMO_STORAGE_S3: JSON.stringify({
      bucket: 'b',
      region: 'us-east-1',
      access_key_id: 'AKIA',
      secret_access_key: 'SECRET',
    }),
  });
  expect(sess.storage?.s3.bucket).toBe('b');
  expect(sess.storage?.s3.prefix).toBe('');
});

test('malformed DEMO_STORAGE_S3 JSON throws with clear message', () => {
  expect(() =>
    buildDemoSession({ ...baseEnv, DEMO_STORAGE_S3: 'not-json' }),
  ).toThrow(/DEMO_STORAGE_S3/);
});

test('DEMO_STORAGE_S3 missing fields fail schema validation', () => {
  expect(() =>
    buildDemoSession({
      ...baseEnv,
      DEMO_STORAGE_S3: JSON.stringify({ bucket: 'b' }),
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement builder**

Replace `/home/joao/augchatd/src/config/demo.ts`:

```typescript
import { DemoSessionPayloadSchema, type DemoSessionPayload } from './session-schema';

function parseStorage(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return { s3: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`DEMO_STORAGE_S3 is not valid JSON: ${(e as Error).message}`);
  }
}

export function buildDemoSession(env: Record<string, string | undefined>): DemoSessionPayload {
  const payload: unknown = {
    user_id: 'demo-user',
    system_prompt: env.DEMO_SYSTEM_PROMPT,
    model: {
      provider: env.DEMO_MODEL_PROVIDER,
      model_id: env.DEMO_MODEL_ID,
      api_key: env.DEMO_MODEL_API_KEY,
    },
    storage: parseStorage(env.DEMO_STORAGE_S3),
  };
  return DemoSessionPayloadSchema.parse(payload);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/demo.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/demo.ts tests/config/demo.test.ts
git commit -m "feat(config): DEMO_STORAGE_S3 as JSON, storage optional in demo"
```

---

### Task 4: S3 client wrapper (interface + Bun-backed impl + in-memory fake)

**Files:**
- Create: `src/storage/s3-client.ts`
- Create: `tests/storage/s3-client.test.ts`

Per spec §4.4 + §5.4: every PUT/GET/DELETE goes through one interface that returns categorized errors. Tests use a fake. Production wires `Bun.S3Client` (requires Bun ≥ 1.1.43; bump engine in `package.json` as part of this task).

- [ ] **Step 1: Bump Bun engine in `package.json`**

In `/home/joao/augchatd/package.json`, add `engines`:

```json
{
  "engines": { "bun": ">=1.1.43" }
}
```

Place it adjacent to `"private": true`.

- [ ] **Step 2: Write failing tests for the fake**

Create `/home/joao/augchatd/tests/storage/s3-client.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createFakeS3Client } from '../../src/storage/s3-client';

const cfg = {
  bucket: 'b',
  prefix: 'p/',
  region: 'us-east-1',
  access_key_id: 'AKIA',
  secret_access_key: 'S',
  force_path_style: false,
};

test('fake put + get round trip', async () => {
  const s3 = createFakeS3Client();
  await s3.put(cfg, 'x/y.json', new TextEncoder().encode('{"hi":1}'), 'application/json');
  const got = await s3.get(cfg, 'x/y.json');
  expect(new TextDecoder().decode(got.body)).toBe('{"hi":1}');
});

test('fake get missing key returns notFound error', async () => {
  const s3 = createFakeS3Client();
  await expect(s3.get(cfg, 'missing')).rejects.toMatchObject({ kind: 'not_found' });
});

test('fake delete removes key', async () => {
  const s3 = createFakeS3Client();
  await s3.put(cfg, 'k', new Uint8Array([1, 2, 3]), 'application/octet-stream');
  await s3.delete(cfg, 'k');
  await expect(s3.get(cfg, 'k')).rejects.toMatchObject({ kind: 'not_found' });
});

test('fake honors prefix isolation per bucket', async () => {
  const s3 = createFakeS3Client();
  await s3.put(cfg, 'shared', new Uint8Array([1]), 'application/octet-stream');
  const other = { ...cfg, bucket: 'other' };
  await expect(s3.get(other, 'shared')).rejects.toMatchObject({ kind: 'not_found' });
});

test('fake can simulate failures programmatically', async () => {
  const s3 = createFakeS3Client();
  s3.failNext({ kind: 'auth' });
  await expect(s3.put(cfg, 'x', new Uint8Array([1]), 'application/json')).rejects.toMatchObject({
    kind: 'auth',
  });
  // After consumed, next call succeeds
  await s3.put(cfg, 'x', new Uint8Array([1]), 'application/json');
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test tests/storage/s3-client.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement S3 client**

Create `/home/joao/augchatd/src/storage/s3-client.ts`:

```typescript
import type { S3Config } from '../config/session-schema';

export type S3ErrorKind =
  | 'timeout'
  | 'auth'
  | 'not_found'
  | 'forbidden'
  | 'server_error'
  | 'unknown';

export interface S3Error {
  kind: S3ErrorKind;
  endpointHost: string;
  status?: number;
}

export interface S3GetResult {
  body: Uint8Array;
  contentType?: string;
}

export interface S3Client {
  put(cfg: S3Config, key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(cfg: S3Config, key: string): Promise<S3GetResult>;
  delete(cfg: S3Config, key: string): Promise<void>;
}

export interface FakeS3Client extends S3Client {
  failNext(error: { kind: S3ErrorKind; status?: number }): void;
  inspect(): Map<string, Uint8Array>; // bucket+key → body
}

function fullKey(cfg: S3Config, key: string): string {
  return `${cfg.bucket}/${cfg.prefix}${key}`;
}

function endpointHost(cfg: S3Config): string {
  if (cfg.endpoint) {
    try {
      return new URL(cfg.endpoint).host;
    } catch {
      return cfg.endpoint;
    }
  }
  return `s3.${cfg.region}.amazonaws.com`;
}

export function createFakeS3Client(): FakeS3Client {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  const failures: Array<{ kind: S3ErrorKind; status?: number }> = [];

  const consumeFailure = (cfg: S3Config): void => {
    const f = failures.shift();
    if (!f) return;
    throw { kind: f.kind, endpointHost: endpointHost(cfg), status: f.status } satisfies S3Error;
  };

  return {
    async put(cfg, key, body, contentType) {
      consumeFailure(cfg);
      store.set(fullKey(cfg, key), { body, contentType });
    },
    async get(cfg, key) {
      consumeFailure(cfg);
      const v = store.get(fullKey(cfg, key));
      if (!v) throw { kind: 'not_found', endpointHost: endpointHost(cfg), status: 404 } satisfies S3Error;
      return { body: v.body, contentType: v.contentType };
    },
    async delete(cfg, key) {
      consumeFailure(cfg);
      store.delete(fullKey(cfg, key));
    },
    failNext(error) {
      failures.push(error);
    },
    inspect() {
      return new Map([...store.entries()].map(([k, v]) => [k, v.body]));
    },
  };
}

function mapBunError(e: unknown, cfg: S3Config): S3Error {
  const host = endpointHost(cfg);
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('aborted')) {
      return { kind: 'timeout', endpointHost: host };
    }
    const statusMatch = msg.match(/\b(\d{3})\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    if (status === 401) return { kind: 'auth', endpointHost: host, status };
    if (status === 403) return { kind: 'forbidden', endpointHost: host, status };
    if (status === 404) return { kind: 'not_found', endpointHost: host, status };
    if (status && status >= 500) return { kind: 'server_error', endpointHost: host, status };
  }
  return { kind: 'unknown', endpointHost: host };
}

export function createBunS3Client(): S3Client {
  // Bun.S3Client is provided at runtime by Bun >= 1.1.43.
  type BunS3Ctor = new (opts: Record<string, unknown>) => {
    file(key: string): {
      write(data: Uint8Array, opts?: { type?: string }): Promise<void>;
      bytes(): Promise<Uint8Array>;
      delete(): Promise<void>;
    };
  };
  const BunS3 = (globalThis as { Bun?: { S3Client?: BunS3Ctor } }).Bun?.S3Client;
  if (!BunS3) {
    throw new Error('Bun.S3Client unavailable (need Bun >= 1.1.43)');
  }

  const clientFor = (cfg: S3Config) =>
    new BunS3({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
      endpoint: cfg.endpoint,
    });

  return {
    async put(cfg, key, body, contentType) {
      try {
        await clientFor(cfg).file(`${cfg.prefix}${key}`).write(body, { type: contentType });
      } catch (e) {
        throw mapBunError(e, cfg);
      }
    },
    async get(cfg, key) {
      try {
        const body = await clientFor(cfg).file(`${cfg.prefix}${key}`).bytes();
        return { body };
      } catch (e) {
        throw mapBunError(e, cfg);
      }
    },
    async delete(cfg, key) {
      try {
        await clientFor(cfg).file(`${cfg.prefix}${key}`).delete();
      } catch (e) {
        throw mapBunError(e, cfg);
      }
    },
  };
}

export function isS3Error(e: unknown): e is S3Error {
  return typeof e === 'object' && e !== null && 'kind' in e && 'endpointHost' in e;
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test tests/storage/s3-client.test.ts`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add src/storage/s3-client.ts tests/storage/s3-client.test.ts package.json
git commit -m "feat(storage): S3Client interface + Bun-backed impl + in-memory fake"
```

---

### Task 5: NDJSON serialization (messages + meta)

**Files:**
- Create: `src/storage/ndjson.ts`
- Create: `tests/storage/ndjson.test.ts`

Per spec §5.4: one JSON object per line (no internal newlines), deterministic key order, sorted by `created_at` then `id`. `meta.json` is a single canonical JSON object.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/ndjson.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { serializeMessages, serializeMeta, parseMessages, parseMeta } from '../../src/storage/ndjson';
import type { Message } from '../../src/storage/messages';
import type { Conversation } from '../../src/storage/conversations';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  conversationId: 'c',
  role: 'user',
  content: 'hi',
  toolCalls: null,
  modelIdUsed: null,
  createdAt: 1000,
  flushedAt: null,
  stoppedByUser: false,
  stoppedByShutdown: false,
  ...over,
});

test('serializeMessages emits one JSON object per line', () => {
  const out = serializeMessages([msg({ id: 'a' }), msg({ id: 'b', createdAt: 1001 })]);
  const lines = out.split('\n').filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).id).toBe('a');
});

test('serializeMessages sorts by created_at then id', () => {
  const out = serializeMessages([
    msg({ id: 'c', createdAt: 2 }),
    msg({ id: 'a', createdAt: 1 }),
    msg({ id: 'b', createdAt: 1 }),
  ]);
  const ids = out.split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  expect(ids).toEqual(['a', 'b', 'c']);
});

test('serializeMessages omits internal flushed_at field', () => {
  const out = serializeMessages([msg({ id: 'a', flushedAt: 999 })]);
  const obj = JSON.parse(out.split('\n')[0]!);
  expect(obj).not.toHaveProperty('flushed_at');
  expect(obj).toHaveProperty('stopped_by_user');
});

test('parseMessages reverses serializeMessages', () => {
  const inputs = [msg({ id: 'a' }), msg({ id: 'b', createdAt: 2, role: 'assistant', modelIdUsed: 'cl' })];
  const text = serializeMessages(inputs);
  const back = parseMessages(text, 'c');
  expect(back).toHaveLength(2);
  expect(back[0]!.id).toBe('a');
  expect(back[1]!.modelIdUsed).toBe('cl');
});

test('serializeMeta emits canonical JSON with schema_version', () => {
  const conv: Conversation = {
    id: 'c',
    userId: 'u',
    title: 'hi',
    createdAt: 100,
    updatedAt: 200,
  };
  const out = serializeMeta(conv, 'claude-opus-4-7');
  const obj = JSON.parse(out);
  expect(obj.schema_version).toBe(1);
  expect(obj.default_model).toBe('claude-opus-4-7');
  expect(obj.created_at).toBe(100);
});

test('parseMeta reverses serializeMeta', () => {
  const conv: Conversation = {
    id: 'c',
    userId: 'u',
    title: null,
    createdAt: 100,
    updatedAt: 200,
  };
  const out = serializeMeta(conv, null);
  const back = parseMeta(out);
  expect(back.id).toBe('c');
  expect(back.userId).toBe('u');
  expect(back.title).toBeNull();
  expect(back.defaultModel).toBeNull();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/ndjson.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement serializer/parser**

Create `/home/joao/augchatd/src/storage/ndjson.ts`:

```typescript
import type { Message, NewMessage } from './messages';
import type { Conversation } from './conversations';

interface MessageLine {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
  model_id_used: string | null;
  tool_calls: string | null;
  stopped_by_user: boolean;
  stopped_by_shutdown: boolean;
}

interface MetaJson {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  default_model: string | null;
  schema_version: 1;
}

export interface ParsedMeta {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  defaultModel: string | null;
}

const sortMessages = (a: Message, b: Message): number =>
  a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id);

export function serializeMessages(messages: Message[]): string {
  const sorted = [...messages].sort(sortMessages);
  return sorted
    .map((m) => {
      const line: MessageLine = {
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.createdAt,
        model_id_used: m.modelIdUsed,
        tool_calls: m.toolCalls,
        stopped_by_user: m.stoppedByUser,
        stopped_by_shutdown: m.stoppedByShutdown,
      };
      return JSON.stringify(line);
    })
    .join('\n') + (sorted.length > 0 ? '\n' : '');
}

export function parseMessages(text: string, conversationId: string): NewMessage[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const obj = JSON.parse(line) as MessageLine;
      return {
        id: obj.id,
        conversationId,
        role: obj.role,
        content: obj.content,
        createdAt: obj.created_at,
        modelIdUsed: obj.model_id_used ?? undefined,
        toolCalls: obj.tool_calls ?? undefined,
      };
    });
}

export function serializeMeta(conv: Conversation, defaultModel: string | null): string {
  const meta: MetaJson = {
    id: conv.id,
    user_id: conv.userId,
    title: conv.title,
    created_at: conv.createdAt,
    updated_at: conv.updatedAt,
    default_model: defaultModel,
    schema_version: 1,
  };
  return JSON.stringify(meta);
}

export function parseMeta(text: string): ParsedMeta {
  const obj = JSON.parse(text) as MetaJson;
  return {
    id: obj.id,
    userId: obj.user_id,
    title: obj.title,
    createdAt: obj.created_at,
    updatedAt: obj.updated_at,
    defaultModel: obj.default_model,
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/ndjson.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/ndjson.ts tests/storage/ndjson.test.ts
git commit -m "feat(storage): NDJSON serialization for messages + canonical meta.json"
```

---

### Task 6: SessionEntry upgrades — createdAt + conversationsTouched + onEvict hook

**Files:**
- Modify: `src/auth/sessions.ts`
- Modify: `tests/auth/sessions.test.ts`

Per spec §5.2: `SessionEntry` gains `createdAt: number` and `conversationsTouched: Set<string>`. Per §5.6: eviction (lazy or `delete()`) fires an `onEvict(sid, entry)` callback so the flush queue can enqueue. The session store accepts that callback at construction.

- [ ] **Step 1: Update tests**

Replace `/home/joao/augchatd/tests/auth/sessions.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createSessionStore, type SessionEntry } from '../../src/auth/sessions';

const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  tenantId: 'urn:tenant:demo',
  userId: 'demo-user',
  modelProvider: 'anthropic',
  modelId: 'claude-opus-4-7',
  modelApiKey: 'sk-ant-x',
  systemPrompt: 'be helpful',
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  stale: false,
  conversationsTouched: new Set<string>(),
  ...overrides,
});

test('put + get returns same entry with empty touched set', () => {
  const s = createSessionStore({});
  s.put('sid_x', entry());
  expect(s.get('sid_x')?.conversationsTouched.size).toBe(0);
});

test('touchConversation records the id on the entry', () => {
  const s = createSessionStore({});
  s.put('sid_x', entry());
  s.touchConversation('sid_x', 'conv-1');
  s.touchConversation('sid_x', 'conv-2');
  s.touchConversation('sid_x', 'conv-1'); // dedup
  const e = s.get('sid_x')!;
  expect([...e.conversationsTouched].sort()).toEqual(['conv-1', 'conv-2']);
});

test('lazy eviction fires onEvict callback with touched set', () => {
  const evicted: Array<{ sid: string; convs: string[] }> = [];
  const s = createSessionStore({ onEvict: (sid, e) => evicted.push({ sid, convs: [...e.conversationsTouched] }) });
  s.put('sid_x', entry({ expiresAt: Date.now() - 1000 }));
  s.touchConversation('sid_x', 'conv-1');
  s.get('sid_x'); // triggers lazy eviction
  expect(evicted).toEqual([{ sid: 'sid_x', convs: ['conv-1'] }]);
});

test('delete fires onEvict', () => {
  const evicted: string[] = [];
  const s = createSessionStore({ onEvict: (sid) => evicted.push(sid) });
  s.put('sid_x', entry());
  s.delete('sid_x');
  expect(evicted).toEqual(['sid_x']);
});

test('list returns currently-live entries', () => {
  const s = createSessionStore({});
  s.put('sid_a', entry({ userId: 'u1' }));
  s.put('sid_b', entry({ userId: 'u2', expiresAt: Date.now() - 1 }));
  // Touch 'sid_b' to ensure it is still in the map until lazy eviction
  const live = s.list();
  expect(live.map(([sid]) => sid).sort()).toEqual(['sid_a', 'sid_b']);
});

test('markStale flips flag without firing eviction', () => {
  const evicted: string[] = [];
  const s = createSessionStore({ onEvict: (sid) => evicted.push(sid) });
  s.put('sid_x', entry());
  s.markStale('sid_x');
  expect(s.get('sid_x')?.stale).toBe(true);
  expect(evicted).toEqual([]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/auth/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement updated store**

Replace `/home/joao/augchatd/src/auth/sessions.ts`:

```typescript
import type { S3Config } from '../config/session-schema';

export interface SessionEntry {
  tenantId: string;
  userId: string;
  modelProvider: 'anthropic';
  modelId: string;
  modelApiKey: string;
  systemPrompt: string;
  storage?: { s3: S3Config };
  expiresAt: number;
  createdAt: number;
  stale: boolean;
  conversationsTouched: Set<string>;
}

export type EvictReason = 'ttl' | 'delete';

export interface SessionStoreOptions {
  onEvict?: (sid: string, entry: SessionEntry, reason: EvictReason) => void;
}

export interface SessionStore {
  put(sid: string, entry: SessionEntry): void;
  get(sid: string): SessionEntry | undefined;
  delete(sid: string): void;
  markStale(sid: string): void;
  touchConversation(sid: string, conversationId: string): void;
  list(): Array<[string, SessionEntry]>;
  forTenant(tenantId: string): SessionEntry[];
}

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const map = new Map<string, SessionEntry>();
  return {
    put(sid, entry) {
      map.set(sid, entry);
    },
    get(sid) {
      const e = map.get(sid);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) {
        map.delete(sid);
        opts.onEvict?.(sid, e, 'ttl');
        return undefined;
      }
      return e;
    },
    delete(sid) {
      const e = map.get(sid);
      if (!e) return;
      map.delete(sid);
      opts.onEvict?.(sid, e, 'delete');
    },
    markStale(sid) {
      const e = map.get(sid);
      if (e) e.stale = true;
    },
    touchConversation(sid, conversationId) {
      const e = map.get(sid);
      if (e) e.conversationsTouched.add(conversationId);
    },
    list() {
      return [...map.entries()];
    },
    forTenant(tenantId) {
      const out: SessionEntry[] = [];
      for (const e of map.values()) if (e.tenantId === tenantId) out.push(e);
      return out;
    },
  };
}
```

- [ ] **Step 4: Update Fatia 1 call sites passing the old shape**

The Fatia 1 code constructed `SessionEntry` without `createdAt` / `conversationsTouched`. Find all constructors and add the missing fields. Most likely sites: `src/index.ts` (demo boot), JWT middleware (when reading entry).

Run: `grep -rn "tenantId:\s*" src/`

For each `SessionEntry` literal, add:
```typescript
createdAt: Date.now(),
conversationsTouched: new Set<string>(),
```

Also: `createSessionStore()` → `createSessionStore({})` (or pass a real `onEvict` later in Task 11).

Update the messages route (Fatia 1) to call `sessions.touchConversation(sid, conversationId)` after the conversation is ensured. The middleware exposes `sid` on the Hono context; add the call right before passing into `streamText`.

Run: `bunx tsc --noEmit`
Fix any type errors.

- [ ] **Step 5: Run, verify pass**

Run: `bun test tests/auth/sessions.test.ts`
Expected: 6 passing.

Run: `bun test`
Expected: all suites pass (Fatia 1 + Fatia 2 so far).

- [ ] **Step 6: Commit**

```bash
git add src/auth/sessions.ts tests/auth/sessions.test.ts src/server/routes/messages.ts src/index.ts
git commit -m "feat(auth): SessionEntry gains createdAt + conversationsTouched + onEvict"
```

---

### Task 7: Tenant registry (lazy open + idle close timer)

**Files:**
- Create: `src/storage/tenant-registry.ts`
- Create: `tests/storage/tenant-registry.test.ts`

Per spec §5.5: a registry of `TenantHandle` objects keyed by `tenantId`. Lazy open on first access. Close after `AUGCHATD_TENANT_IDLE_CLOSE_SECONDS` of no activity AND no `pendingFlushes`. Reopens lazily next access.

Replaces the simple `openTenantDb` / `closeAllDbs` from Fatia 1. The Fatia 1 module stays (kept as low-level open) but the registry wraps it with lifecycle.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/tenant-registry.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-reg-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('get opens a tenant lazily on first access', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const h = reg.get('t1');
  expect(h.tenantId).toBe('t1');
  expect(h.db).toBeDefined();
});

test('get returns same handle for same tenant', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  expect(reg.get('t1')).toBe(reg.get('t1'));
});

test('touch updates lastActivityAt', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const h = reg.get('t1');
  const before = h.lastActivityAt;
  await Bun.sleep(5);
  reg.touch('t1');
  expect(h.lastActivityAt).toBeGreaterThan(before);
});

test('idle close removes the handle once timer expires and no pending', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 0.05 }); // 50ms
  reg.get('t1');
  await Bun.sleep(120);
  expect(reg.peek('t1')).toBeUndefined();
});

test('idle close skipped while pendingFlushes > 0', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 0.05 });
  const h = reg.get('t1');
  h.pendingFlushes.set('conv-1', { conversationId: 'conv-1', attemptCount: 0, nextAttemptAt: 0, lastError: null, inFlight: false });
  await Bun.sleep(120);
  expect(reg.peek('t1')).toBeDefined();
});

test('shutdownAll closes every handle synchronously', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  reg.get('t1');
  reg.get('t2');
  reg.shutdownAll();
  expect(reg.peek('t1')).toBeUndefined();
  expect(reg.peek('t2')).toBeUndefined();
});

test('listOpenTenants returns currently open tenants', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  reg.get('t1');
  reg.get('t2');
  expect(reg.listOpenTenants().sort()).toEqual(['t1', 't2']);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/tenant-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement registry**

Create `/home/joao/augchatd/src/storage/tenant-registry.ts`:

```typescript
import type { Database } from 'bun:sqlite';
import { openTenantDb } from './db';

export interface FlushState {
  conversationId: string;
  nextAttemptAt: number;
  attemptCount: number;
  lastError: string | null;
  inFlight: boolean;
}

export interface TenantHandle {
  tenantId: string;
  db: Database;
  openedAt: number;
  lastActivityAt: number;
  pendingFlushes: Map<string, FlushState>;
  idleCloseTimer: ReturnType<typeof setTimeout> | null;
}

export interface TenantRegistryOptions {
  hotDir: string;
  idleCloseSeconds: number;
}

export interface TenantRegistry {
  get(tenantId: string): TenantHandle;
  peek(tenantId: string): TenantHandle | undefined;
  touch(tenantId: string): void;
  closeIfIdle(tenantId: string): boolean;
  shutdownAll(): void;
  listOpenTenants(): string[];
}

export function createTenantRegistry(opts: TenantRegistryOptions): TenantRegistry {
  const handles = new Map<string, TenantHandle>();

  const armIdleCloseTimer = (h: TenantHandle): void => {
    if (h.idleCloseTimer) clearTimeout(h.idleCloseTimer);
    h.idleCloseTimer = setTimeout(() => {
      if (h.pendingFlushes.size === 0) {
        h.db.close(false);
        handles.delete(h.tenantId);
      } else {
        armIdleCloseTimer(h);
      }
    }, opts.idleCloseSeconds * 1000);
  };

  const reg: TenantRegistry = {
    get(tenantId) {
      const existing = handles.get(tenantId);
      if (existing) {
        existing.lastActivityAt = Date.now();
        armIdleCloseTimer(existing);
        return existing;
      }
      const db = openTenantDb(tenantId, opts.hotDir);
      const h: TenantHandle = {
        tenantId,
        db,
        openedAt: Date.now(),
        lastActivityAt: Date.now(),
        pendingFlushes: new Map(),
        idleCloseTimer: null,
      };
      handles.set(tenantId, h);
      armIdleCloseTimer(h);
      return h;
    },
    peek(tenantId) {
      return handles.get(tenantId);
    },
    touch(tenantId) {
      const h = handles.get(tenantId);
      if (h) {
        h.lastActivityAt = Date.now();
        armIdleCloseTimer(h);
      }
    },
    closeIfIdle(tenantId) {
      const h = handles.get(tenantId);
      if (!h) return false;
      if (h.pendingFlushes.size > 0) return false;
      if (h.idleCloseTimer) clearTimeout(h.idleCloseTimer);
      h.db.close(false);
      handles.delete(tenantId);
      return true;
    },
    shutdownAll() {
      for (const h of handles.values()) {
        if (h.idleCloseTimer) clearTimeout(h.idleCloseTimer);
        h.db.close(false);
      }
      handles.clear();
    },
    listOpenTenants() {
      return [...handles.keys()];
    },
  };

  return reg;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/tenant-registry.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Migrate Fatia 1 call sites to use the registry**

The conversations / messages routes currently call `openTenantDb(tenantId, hotDir)` directly. Wire them through the registry instead — pass `tenantRegistry` into `AppCtx`, replace `openTenantDb(...)` with `tenantRegistry.get(tenantId).db`.

Steps:
1. Add `tenantRegistry: TenantRegistry` to `AppCtx` in `src/server/app.ts`.
2. Replace `openTenantDb` calls in route handlers with `ctx.tenantRegistry.get(tenantId).db`.
3. Update `src/index.ts` boot to construct the registry once and pass it in.

Run: `bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/storage/tenant-registry.ts tests/storage/tenant-registry.test.ts src/server/app.ts src/server/routes src/index.ts
git commit -m "feat(storage): tenant registry with lazy open + idle close"
```

---

### Task 8: Cold delete helper (DELETE both known keys)

**Files:**
- Create: `src/storage/cold-delete.ts`
- Create: `tests/storage/cold-delete.test.ts`

Per spec §5.4 DELETE: removes exactly two known keys per conversation. Failures logged but not propagated.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/cold-delete.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { deleteConversationCold, conversationS3Keys } from '../../src/storage/cold-delete';
import { createFakeS3Client } from '../../src/storage/s3-client';

const cfg = {
  bucket: 'b',
  prefix: '',
  region: 'us-east-1',
  access_key_id: 'AKIA',
  secret_access_key: 'S',
  force_path_style: false,
};

test('conversationS3Keys returns meta then messages', () => {
  expect(conversationS3Keys('urn:t:x', 'u', 'c')).toEqual([
    'urn%3At%3Ax/u/c/meta.json',
    'urn%3At%3Ax/u/c/messages.ndjson',
  ]);
});

test('deleteConversationCold removes both keys', async () => {
  const s3 = createFakeS3Client();
  await s3.put(cfg, 'urn%3At%3Ax/u/c/meta.json', new Uint8Array([1]), 'application/json');
  await s3.put(cfg, 'urn%3At%3Ax/u/c/messages.ndjson', new Uint8Array([2]), 'application/x-ndjson');
  await deleteConversationCold(s3, cfg, 'urn:t:x', 'u', 'c');
  expect(s3.inspect().size).toBe(0);
});

test('deleteConversationCold tolerates missing key', async () => {
  const s3 = createFakeS3Client();
  await s3.put(cfg, 'urn%3At%3Ax/u/c/meta.json', new Uint8Array([1]), 'application/json');
  // messages.ndjson never written; delete should not throw
  await deleteConversationCold(s3, cfg, 'urn:t:x', 'u', 'c');
});

test('deleteConversationCold logs but does not throw other errors', async () => {
  const s3 = createFakeS3Client();
  s3.failNext({ kind: 'server_error', status: 500 });
  await deleteConversationCold(s3, cfg, 'urn:t:x', 'u', 'c'); // must not throw
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/cold-delete.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement helper**

Create `/home/joao/augchatd/src/storage/cold-delete.ts`:

```typescript
import { isS3Error, type S3Client } from './s3-client';
import type { S3Config } from '../config/session-schema';
import { log } from '../log';

export function conversationS3Keys(tenantId: string, userId: string, conversationId: string): [string, string] {
  const base = `${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/${encodeURIComponent(conversationId)}`;
  return [`${base}/meta.json`, `${base}/messages.ndjson`];
}

export async function deleteConversationCold(
  s3: S3Client,
  cfg: S3Config,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<void> {
  const [metaKey, msgKey] = conversationS3Keys(tenantId, userId, conversationId);
  for (const key of [metaKey, msgKey]) {
    try {
      await s3.delete(cfg, key);
    } catch (e) {
      if (isS3Error(e) && e.kind === 'not_found') continue;
      log.warn('cold_delete_failed', 'best-effort delete of conversation prefix failed', {
        tenant_id: tenantId,
        conversation_id: conversationId,
        key,
        error_kind: isS3Error(e) ? e.kind : 'unknown',
      });
    }
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/cold-delete.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/cold-delete.ts tests/storage/cold-delete.test.ts
git commit -m "feat(storage): cold delete helper for conversation prefix (best-effort)"
```

---

### Task 9: Flush queue core (schedule, cancel, execution with backoff)

**Files:**
- Create: `src/storage/flush-queue.ts`
- Create: `tests/storage/flush-queue.test.ts`

Per spec §5.6: singleton; `scheduleConversation(tenantId, conversationId, reason)` and `cancelConversation(tenantId, conversationId)`. Executes against an injected `S3Client`. Resolves S3 creds by asking the session store for any live session matching `(tenantId, userId)`. Updates `flushed_at` after successful PUT. On failure: backoff with cap. Time and timers are injected via a `Clock` interface for tests.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/flush-queue.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { appendMessage } from '../../src/storage/messages';
import { createFlushQueue } from '../../src/storage/flush-queue';
import { createFakeS3Client } from '../../src/storage/s3-client';
import { createSessionStore } from '../../src/auth/sessions';
import type { SessionEntry } from '../../src/auth/sessions';

let hotDir: string;

const s3cfg = {
  bucket: 'b',
  prefix: 'p/',
  region: 'us-east-1',
  access_key_id: 'AKIA',
  secret_access_key: 'S',
  force_path_style: false,
};

const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
  tenantId: 't1',
  userId: 'u1',
  modelProvider: 'anthropic',
  modelId: 'cl',
  modelApiKey: 'k',
  systemPrompt: 'sp',
  storage: { s3: s3cfg },
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  stale: false,
  conversationsTouched: new Set(),
  ...over,
});

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-fq-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('schedule + run flushes a conversation; flushed_at gets set', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  sessions.put('sid', entry());
  const s3 = createFakeS3Client();
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });

  const h = reg.get('t1');
  ensureConversation(h.db, 'conv-a', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'conv-a', role: 'user', content: 'hi', createdAt: 100 });

  q.scheduleConversation('t1', 'conv-a', 'session_eviction');
  await q.runOnce(); // synchronously processes any due flush

  const row = h.db.query('SELECT flushed_at FROM messages WHERE id=?').get('m1') as { flushed_at: number };
  expect(row.flushed_at).toBeGreaterThan(0);
  const keys = [...s3.inspect().keys()];
  expect(keys).toContain('b/p/t1/u1/conv-a/meta.json');
  expect(keys).toContain('b/p/t1/u1/conv-a/messages.ndjson');
});

test('flush waits when no live session has matching creds', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  const s3 = createFakeS3Client();
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
  const h = reg.get('t1');
  ensureConversation(h.db, 'conv-a', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'conv-a', role: 'user', content: 'hi', createdAt: 100 });

  q.scheduleConversation('t1', 'conv-a', 'session_eviction');
  await q.runOnce();

  const row = h.db.query('SELECT flushed_at FROM messages WHERE id=?').get('m1') as { flushed_at: number | null };
  expect(row.flushed_at).toBeNull(); // still pending
  expect(h.pendingFlushes.has('conv-a')).toBe(true);
});

test('failed PUT increases attemptCount with exponential delay', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  sessions.put('sid', entry());
  const s3 = createFakeS3Client();
  s3.failNext({ kind: 'server_error', status: 502 });
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
  const h = reg.get('t1');
  ensureConversation(h.db, 'conv-a', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'conv-a', role: 'user', content: 'hi', createdAt: 100 });

  q.scheduleConversation('t1', 'conv-a', 'session_eviction');
  await q.runOnce();

  const state = h.pendingFlushes.get('conv-a')!;
  expect(state.attemptCount).toBe(1);
  expect(state.lastError).toBe('server_error');
  expect(state.nextAttemptAt).toBeGreaterThan(Date.now());
});

test('cancelConversation removes pending entry', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  const s3 = createFakeS3Client();
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
  reg.get('t1');
  q.scheduleConversation('t1', 'conv-a', 'session_eviction');
  q.cancelConversation('t1', 'conv-a');
  const h = reg.get('t1');
  expect(h.pendingFlushes.has('conv-a')).toBe(false);
});

test('flushAllNow is idempotent and synchronous over multiple convs', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  sessions.put('sid', entry());
  const s3 = createFakeS3Client();
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
  const h = reg.get('t1');
  for (const id of ['a', 'b', 'c']) {
    ensureConversation(h.db, id, 'u1');
    appendMessage(h.db, { id: `m-${id}`, conversationId: id, role: 'user', content: 'x', createdAt: 1 });
    q.scheduleConversation('t1', id, 'session_eviction');
  }
  await q.flushAllNow();
  expect(s3.inspect().size).toBe(6); // 3 convs * 2 files
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/flush-queue.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement flush queue**

Create `/home/joao/augchatd/src/storage/flush-queue.ts`:

```typescript
import type { Database } from 'bun:sqlite';
import type { TenantRegistry } from './tenant-registry';
import type { SessionStore } from '../auth/sessions';
import type { S3Client, S3Error } from './s3-client';
import { isS3Error } from './s3-client';
import { getConversation } from './conversations';
import { listMessages } from './messages';
import { serializeMessages, serializeMeta } from './ndjson';
import { conversationS3Keys } from './cold-delete';
import type { S3Config } from '../config/session-schema';
import { log } from '../log';

export type FlushReason = 'session_eviction' | 'idle' | 'recovery' | 'shutdown';

export interface FlushQueueOptions {
  s3: S3Client;
  sessions: SessionStore;
  tenantRegistry: TenantRegistry;
  backoffCapSeconds: number;
  now?: () => number;
}

export interface FlushQueue {
  scheduleConversation(tenantId: string, conversationId: string, reason: FlushReason): void;
  cancelConversation(tenantId: string, conversationId: string): void;
  runOnce(): Promise<void>;
  flushAllNow(): Promise<void>;
  start(): void;
  stop(): void;
}

function findCredsFor(
  sessions: SessionStore,
  tenantId: string,
  userId: string,
): S3Config | undefined {
  for (const e of sessions.forTenant(tenantId)) {
    if (e.userId === userId && e.storage) return e.storage.s3;
  }
  return undefined;
}

function backoffMs(attempt: number, capSeconds: number): number {
  return Math.min(2 ** attempt * 1000, capSeconds * 1000);
}

function markFlushed(db: Database, conversationId: string, now: number): void {
  db.run('UPDATE messages SET flushed_at = ? WHERE conversation_id = ? AND flushed_at IS NULL', [
    now,
    conversationId,
  ]);
}

function writeDiagnostic(db: Database, key: string, value: string): void {
  db.run(
    'INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, value],
  );
}

export function createFlushQueue(opts: FlushQueueOptions): FlushQueue {
  const now = opts.now ?? (() => Date.now());
  let stopped = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushOne(tenantId: string, conversationId: string): Promise<void> {
    const handle = opts.tenantRegistry.peek(tenantId);
    if (!handle) return;
    const state = handle.pendingFlushes.get(conversationId);
    if (!state) return;
    if (state.inFlight) return;
    if (state.nextAttemptAt > now()) return;

    const conv = getConversation(handle.db, conversationId);
    if (!conv) {
      handle.pendingFlushes.delete(conversationId);
      return;
    }
    const creds = findCredsFor(opts.sessions, tenantId, conv.userId);
    if (!creds) return; // wait for a session to provide creds

    state.inFlight = true;
    const messages = listMessages(handle.db, conversationId);
    const lastModel = [...messages].reverse().find((m) => m.modelIdUsed)?.modelIdUsed ?? null;
    const metaBody = new TextEncoder().encode(serializeMeta(conv, lastModel));
    const messagesBody = new TextEncoder().encode(serializeMessages(messages));
    const [metaKey, msgKey] = conversationS3Keys(tenantId, conv.userId, conversationId);

    const attempt = state.attemptCount + 1;
    writeDiagnostic(handle.db, 'last_flush_attempt_ts', String(now()));
    log.info('flush.start', 'flushing conversation to S3', {
      tenant_id: tenantId,
      conversation_id: conversationId,
      attempt,
    });

    try {
      await opts.s3.put(creds, metaKey, metaBody, 'application/json');
      await opts.s3.put(creds, msgKey, messagesBody, 'application/x-ndjson');
      markFlushed(handle.db, conversationId, now());
      handle.pendingFlushes.delete(conversationId);
      writeDiagnostic(handle.db, 'last_flush_error', 'ok');
      log.info('flush.ok', 'conversation flushed', {
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_count: messages.length,
      });
    } catch (e) {
      const errKind: S3Error['kind'] = isS3Error(e) ? e.kind : 'unknown';
      state.attemptCount = attempt;
      state.lastError = errKind;
      state.nextAttemptAt = now() + backoffMs(attempt, opts.backoffCapSeconds);
      writeDiagnostic(handle.db, 'last_flush_error', errKind);
      log.warn('flush.retry', 'flush failed; will retry', {
        tenant_id: tenantId,
        conversation_id: conversationId,
        attempt,
        next_attempt_at: state.nextAttemptAt,
        error_kind: errKind,
      });
    } finally {
      state.inFlight = false;
    }
  }

  const q: FlushQueue = {
    scheduleConversation(tenantId, conversationId, reason) {
      const handle = opts.tenantRegistry.get(tenantId);
      const existing = handle.pendingFlushes.get(conversationId);
      if (!existing) {
        handle.pendingFlushes.set(conversationId, {
          conversationId,
          nextAttemptAt: now(),
          attemptCount: 0,
          lastError: null,
          inFlight: false,
        });
      }
      log.debug('flush.scheduled', 'flush enqueued', {
        tenant_id: tenantId,
        conversation_id: conversationId,
        reason,
      });
    },
    cancelConversation(tenantId, conversationId) {
      const handle = opts.tenantRegistry.peek(tenantId);
      if (!handle) return;
      handle.pendingFlushes.delete(conversationId);
    },
    async runOnce() {
      for (const tenantId of opts.tenantRegistry.listOpenTenants()) {
        const handle = opts.tenantRegistry.peek(tenantId);
        if (!handle) continue;
        for (const conversationId of [...handle.pendingFlushes.keys()]) {
          await flushOne(tenantId, conversationId);
        }
      }
    },
    async flushAllNow() {
      // Loop until every pending flush either succeeds or has no creds.
      for (let i = 0; i < 5; i++) {
        await q.runOnce();
        const anyDue = opts.tenantRegistry
          .listOpenTenants()
          .some((t) => {
            const h = opts.tenantRegistry.peek(t);
            return h && [...h.pendingFlushes.values()].some((s) => s.nextAttemptAt <= now());
          });
        if (!anyDue) return;
      }
    },
    start() {
      stopped = false;
      const tick = () => {
        if (stopped) return;
        q.runOnce().finally(() => {
          if (!stopped) loopTimer = setTimeout(tick, 1000);
        });
      };
      tick();
    },
    stop() {
      stopped = true;
      if (loopTimer) clearTimeout(loopTimer);
      loopTimer = null;
    },
  };

  return q;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/flush-queue.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/flush-queue.ts tests/storage/flush-queue.test.ts
git commit -m "feat(storage): flush queue with per-conversation backoff + creds lookup"
```

---

### Task 10: Wire session eviction → flush queue

**Files:**
- Modify: `src/index.ts` (or wherever the session store is constructed)
- Create: `tests/integration/eviction-triggers-flush.test.ts`

Per spec §2 trigger (a) + §5.6: when a session is evicted (lazy or via `DELETE /sessions/{id}`), each conversation it touched is enqueued.

- [ ] **Step 1: Write failing integration test**

Create `/home/joao/augchatd/tests/integration/eviction-triggers-flush.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { appendMessage } from '../../src/storage/messages';
import { createFlushQueue } from '../../src/storage/flush-queue';
import { createFakeS3Client } from '../../src/storage/s3-client';
import { createSessionStore, type SessionEntry } from '../../src/auth/sessions';
import { wireEvictionToFlush } from '../../src/storage/eviction-wiring';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-ev-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

const s3cfg = {
  bucket: 'b',
  prefix: '',
  region: 'us-east-1',
  access_key_id: 'A',
  secret_access_key: 'S',
  force_path_style: false,
};

const baseEntry: Omit<SessionEntry, 'expiresAt' | 'conversationsTouched'> = {
  tenantId: 't1',
  userId: 'u1',
  modelProvider: 'anthropic',
  modelId: 'cl',
  modelApiKey: 'k',
  systemPrompt: 'sp',
  storage: { s3: s3cfg },
  createdAt: 0,
  stale: false,
};

test('delete() fires onEvict which schedules flush for each touched conv', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const sessions = createSessionStore({});
  const q = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
  wireEvictionToFlush(sessions, q);

  // Now put the entry; eviction wiring is in place.
  sessions.put('sid', {
    ...baseEntry,
    expiresAt: Date.now() + 60_000,
    conversationsTouched: new Set(),
  });
  const h = reg.get('t1');
  ensureConversation(h.db, 'c1', 'u1');
  ensureConversation(h.db, 'c2', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'c1', role: 'user', content: 'x', createdAt: 1 });
  appendMessage(h.db, { id: 'm2', conversationId: 'c2', role: 'user', content: 'y', createdAt: 2 });
  sessions.touchConversation('sid', 'c1');
  sessions.touchConversation('sid', 'c2');

  // Put the session back with same creds so flush has creds to use after eviction.
  // (In Fatia 2 §5.6, creds are resolved at flush time by 'any live session for tenant'.)
  sessions.put('sid_alive', {
    ...baseEntry,
    expiresAt: Date.now() + 60_000,
    conversationsTouched: new Set(),
  });

  sessions.delete('sid'); // triggers eviction → schedules c1, c2

  await q.flushAllNow();

  const rows = h.db.query('SELECT id, flushed_at FROM messages').all() as Array<{
    id: string;
    flushed_at: number | null;
  }>;
  expect(rows.every((r) => r.flushed_at !== null)).toBe(true);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/integration/eviction-triggers-flush.test.ts`
Expected: FAIL (`Cannot find module '.../eviction-wiring'`).

- [ ] **Step 3: Implement wiring helper**

Create `/home/joao/augchatd/src/storage/eviction-wiring.ts`:

```typescript
import type { FlushQueue } from './flush-queue';
import { log } from '../log';
import type { SessionStore } from '../auth/sessions';

/**
 * Wire a session store so eviction (lazy TTL or explicit delete) schedules
 * a flush for every conversation the evicted session touched.
 *
 * Must be called BEFORE any session is put — the wiring replaces the
 * store's onEvict handler.
 */
export function wireEvictionToFlush(
  sessions: SessionStore,
  queue: FlushQueue,
): void {
  // The session store accepts onEvict at construction. To keep this composable,
  // we patch by wrapping put() so that we cannot simply set the handler post hoc.
  // Instead, the store must have been constructed with the right onEvict.
  // This helper is the one place that knows the handler shape — call sites
  // build the store *after* constructing the queue, then pass this handler.
  void sessions;
  void queue;
  throw new Error('use createSessionStoreWithFlush() instead');
}

/**
 * Factory that builds a SessionStore whose eviction enqueues flushes.
 * Use this in src/index.ts where both store and queue are constructed.
 */
export interface SessionStoreWithFlushDeps {
  queue: FlushQueue;
}

export function makeOnEvict(queue: FlushQueue) {
  return (sid: string, entry: { tenantId: string; conversationsTouched: Set<string> }, reason: string): void => {
    log.info('session.evicted', 'session evicted', {
      session_id: sid,
      tenant_id: entry.tenantId,
      reason,
      touched_count: entry.conversationsTouched.size,
    });
    for (const conversationId of entry.conversationsTouched) {
      queue.scheduleConversation(entry.tenantId, conversationId, 'session_eviction');
    }
  };
}
```

Replace the throwing `wireEvictionToFlush` with the constructor-pattern below — update the test to construct the store with `onEvict: makeOnEvict(queue)`. Adjust the test:

In `/home/joao/augchatd/tests/integration/eviction-triggers-flush.test.ts`, replace the wiring section with:

```typescript
import { makeOnEvict } from '../../src/storage/eviction-wiring';

const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
const s3 = createFakeS3Client();
// queue needs sessions, sessions needs queue — break cycle with late binding:
let queueRef: ReturnType<typeof createFlushQueue>;
const sessions = createSessionStore({ onEvict: (sid, e, r) => makeOnEvict(queueRef)(sid, e, r) });
queueRef = createFlushQueue({ s3, sessions, tenantRegistry: reg, backoffCapSeconds: 60 });
const q = queueRef;
```

Remove the `wireEvictionToFlush` call.

Also simplify the file by removing `wireEvictionToFlush`:

```typescript
import type { FlushQueue } from './flush-queue';
import type { SessionEntry } from '../auth/sessions';
import { log } from '../log';

export function makeOnEvict(queue: FlushQueue) {
  return (sid: string, entry: SessionEntry, reason: string): void => {
    log.info('session.evicted', 'session evicted', {
      session_id: sid,
      tenant_id: entry.tenantId,
      reason,
      touched_count: entry.conversationsTouched.size,
    });
    for (const conversationId of entry.conversationsTouched) {
      queue.scheduleConversation(entry.tenantId, conversationId, 'session_eviction');
    }
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/integration/eviction-triggers-flush.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Wire into `src/index.ts`**

In `src/index.ts`, the previous boot ordering was:
1. parse env
2. create session store
3. create app
4. serve

New order:
1. parse env
2. create tenant registry
3. create S3 client (BunS3Client)
4. declare `let queue: FlushQueue;`
5. create session store with `onEvict: (sid, e, r) => makeOnEvict(queue)(sid, e, r)`
6. assign `queue = createFlushQueue({ s3, sessions, tenantRegistry, backoffCapSeconds })`
7. `queue.start()`
8. proceed to build app + serve

- [ ] **Step 6: Commit**

```bash
git add src/storage/eviction-wiring.ts src/index.ts tests/integration/eviction-triggers-flush.test.ts
git commit -m "feat(storage): wire session eviction to flush queue"
```

---

### Task 11: Per-conversation idle flush timer

**Files:**
- Modify: `src/storage/messages.ts` (add hook on append)
- Modify: `src/storage/flush-queue.ts` (track idle timers per conv)
- Modify: `tests/storage/flush-queue.test.ts`

Per spec §2 trigger (b): a conversation with no new message for `AUGCHATD_FLUSH_IDLE_SECONDS` schedules itself for flush. Implementation: every time a message is appended, the flush queue's `noteActivity(tenantId, conversationId)` rearms a per-conv timer.

- [ ] **Step 1: Add new test to flush-queue.test.ts**

Append the following test to `tests/storage/flush-queue.test.ts`:

```typescript
test('idle timer schedules flush after configurable interval', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  sessions.put('sid', entry());
  const s3 = createFakeS3Client();
  const q = createFlushQueue({
    s3,
    sessions,
    tenantRegistry: reg,
    backoffCapSeconds: 60,
    idleFlushSeconds: 0.05, // 50ms for the test
  });
  const h = reg.get('t1');
  ensureConversation(h.db, 'conv-idle', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'conv-idle', role: 'user', content: 'hi', createdAt: 100 });
  q.noteActivity('t1', 'conv-idle');

  await Bun.sleep(120);
  await q.runOnce();

  const row = h.db.query('SELECT flushed_at FROM messages WHERE id=?').get('m1') as { flushed_at: number };
  expect(row.flushed_at).toBeGreaterThan(0);
});

test('subsequent activity resets the idle timer', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const sessions = createSessionStore({});
  sessions.put('sid', entry());
  const s3 = createFakeS3Client();
  const q = createFlushQueue({
    s3,
    sessions,
    tenantRegistry: reg,
    backoffCapSeconds: 60,
    idleFlushSeconds: 0.1,
  });
  const h = reg.get('t1');
  ensureConversation(h.db, 'conv-reset', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'conv-reset', role: 'user', content: 'a', createdAt: 100 });
  q.noteActivity('t1', 'conv-reset');
  await Bun.sleep(50);
  appendMessage(h.db, { id: 'm2', conversationId: 'conv-reset', role: 'user', content: 'b', createdAt: 150 });
  q.noteActivity('t1', 'conv-reset');
  await Bun.sleep(60); // 110ms total since first message, only 60ms since second
  await q.runOnce();

  const row = h.db.query('SELECT flushed_at FROM messages WHERE id=?').get('m1') as { flushed_at: number | null };
  expect(row.flushed_at).toBeNull(); // not yet
  await Bun.sleep(60);
  await q.runOnce();
  const row2 = h.db.query('SELECT flushed_at FROM messages WHERE id=?').get('m1') as { flushed_at: number };
  expect(row2.flushed_at).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/flush-queue.test.ts`
Expected: FAIL (`noteActivity` missing, `idleFlushSeconds` not in options).

- [ ] **Step 3: Update flush queue to track per-conv idle timers**

In `src/storage/flush-queue.ts`:

a) Extend `FlushQueueOptions`:
```typescript
export interface FlushQueueOptions {
  s3: S3Client;
  sessions: SessionStore;
  tenantRegistry: TenantRegistry;
  backoffCapSeconds: number;
  idleFlushSeconds?: number;  // default off; production passes from config
  now?: () => number;
}
```

b) Extend `FlushQueue` interface:
```typescript
export interface FlushQueue {
  scheduleConversation(tenantId: string, conversationId: string, reason: FlushReason): void;
  cancelConversation(tenantId: string, conversationId: string): void;
  noteActivity(tenantId: string, conversationId: string): void;
  runOnce(): Promise<void>;
  flushAllNow(): Promise<void>;
  start(): void;
  stop(): void;
}
```

c) Add a per-conv timer map inside `createFlushQueue`:
```typescript
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key: `${tenantId}\0${conversationId}`
```

d) Implement `noteActivity`:
```typescript
noteActivity(tenantId, conversationId) {
  if (!opts.idleFlushSeconds) return;
  const key = `${tenantId}\0${conversationId}`;
  const existing = idleTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    idleTimers.delete(key);
    q.scheduleConversation(tenantId, conversationId, 'idle');
  }, opts.idleFlushSeconds * 1000);
  idleTimers.set(key, timer);
},
```

e) Clear timers in `stop()`:
```typescript
stop() {
  stopped = true;
  if (loopTimer) clearTimeout(loopTimer);
  for (const t of idleTimers.values()) clearTimeout(t);
  idleTimers.clear();
  loopTimer = null;
},
```

f) Also clear the timer on successful flush (right after `pendingFlushes.delete`):
```typescript
const tk = `${tenantId}\0${conversationId}`;
const t = idleTimers.get(tk);
if (t) { clearTimeout(t); idleTimers.delete(tk); }
```

- [ ] **Step 4: Wire `noteActivity` to message appends in the message route**

In `src/server/routes/messages.ts`, after `appendMessage(db, {...})`, call:
```typescript
ctx.flushQueue.noteActivity(tenantId, conversationId);
```

Add `flushQueue: FlushQueue` to `AppCtx` and pass it through from `src/index.ts`.

- [ ] **Step 5: Run, verify pass**

Run: `bun test tests/storage/flush-queue.test.ts`
Expected: 7 passing.

- [ ] **Step 6: Commit**

```bash
git add src/storage/flush-queue.ts src/server/routes/messages.ts src/server/app.ts src/index.ts tests/storage/flush-queue.test.ts
git commit -m "feat(storage): per-conversation idle flush timer"
```

---

### Task 12: GC pass — delete flushed rows after delay

**Files:**
- Create: `src/storage/gc.ts`
- Create: `tests/storage/gc.test.ts`

Per spec §2 GC + §C.3: rows with `flushed_at < now - AUGCHATD_GC_DELAY_SECONDS` deleted in a periodic pass (every 60s).

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/storage/gc.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { runGcPass } from '../../src/storage/gc';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-gc-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('GC deletes rows whose flushed_at is older than the delay', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const h = reg.get('t1');
  ensureConversation(h.db, 'c', 'u');
  const now = Date.now();
  h.db.run(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, flushed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['old', 'c', 'user', 'x', now - 1000, now - 200_000],
  );
  h.db.run(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, flushed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['recent', 'c', 'user', 'y', now - 100, now - 1000],
  );
  h.db.run(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ['unflushed', 'c', 'user', 'z', now],
  );
  runGcPass(reg, { delaySeconds: 60, now: () => now });
  const ids = (h.db.query('SELECT id FROM messages ORDER BY id').all() as { id: string }[]).map(
    (r) => r.id,
  );
  expect(ids.sort()).toEqual(['recent', 'unflushed']);
});

test('GC pass is a no-op when no rows match', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  reg.get('t1');
  expect(() => runGcPass(reg, { delaySeconds: 60 })).not.toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/gc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement GC**

Create `/home/joao/augchatd/src/storage/gc.ts`:

```typescript
import type { TenantRegistry } from './tenant-registry';
import { log } from '../log';

export interface GcOptions {
  delaySeconds: number;
  now?: () => number;
}

export function runGcPass(reg: TenantRegistry, opts: GcOptions): void {
  const now = (opts.now ?? (() => Date.now()))();
  const threshold = now - opts.delaySeconds * 1000;
  let total = 0;
  for (const tenantId of reg.listOpenTenants()) {
    const handle = reg.peek(tenantId);
    if (!handle) continue;
    const before = handle.db
      .query('SELECT COUNT(*) AS n FROM messages WHERE flushed_at IS NOT NULL AND flushed_at < ?')
      .get(threshold) as { n: number };
    if (before.n === 0) continue;
    handle.db.run('DELETE FROM messages WHERE flushed_at IS NOT NULL AND flushed_at < ?', [threshold]);
    total += before.n;
  }
  if (total > 0) {
    log.info('gc.swept', 'hot rows deleted after cold confirmation', { rows: total });
  }
}

export function startGcLoop(reg: TenantRegistry, opts: GcOptions): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = (): void => {
    if (stopped) return;
    try {
      runGcPass(reg, opts);
    } catch (e) {
      log.error('gc.failed', 'gc pass threw', { reason: (e as Error).message });
    }
    timer = setTimeout(tick, 60_000);
  };
  timer = setTimeout(tick, 60_000);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/gc.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Start GC loop in src/index.ts**

After constructing the queue:
```typescript
const gc = startGcLoop(tenantRegistry, { delaySeconds: cfg.gcDelaySeconds });
```

Capture `gc.stop` for shutdown later.

- [ ] **Step 6: Commit**

```bash
git add src/storage/gc.ts tests/storage/gc.test.ts src/index.ts
git commit -m "feat(storage): periodic GC of flushed hot rows"
```

---

### Task 13: Boot recovery scan

**Files:**
- Create: `src/storage/recovery.ts`
- Create: `tests/storage/recovery.test.ts`

Per spec §2 boot recovery + §C.3: at boot, scan `AUGCHATD_HOT_DIR` for `*.sqlite` files. For each, open via the tenant registry, look up `tenant_san_uri` in `tenant_meta` to recover the real tenant id, and for every conversation with at least one `flushed_at IS NULL` row, register a `FlushState` in `pendingFlushes` so the queue picks it up once creds arrive.

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/storage/recovery.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { appendMessage } from '../../src/storage/messages';
import { runBootRecovery } from '../../src/storage/recovery';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-rec-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('recovery scans hot dir and enqueues unflushed conversations', () => {
  // Seed: open a tenant, write rows, close everything (simulate restart).
  const seed = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const h = seed.get('urn:t:acme');
  ensureConversation(h.db, 'c1', 'u1');
  appendMessage(h.db, { id: 'm1', conversationId: 'c1', role: 'user', content: 'x', createdAt: 1 });
  ensureConversation(h.db, 'c2', 'u1');
  // c2 is fully flushed
  appendMessage(h.db, { id: 'm2', conversationId: 'c2', role: 'user', content: 'y', createdAt: 2 });
  h.db.run('UPDATE messages SET flushed_at = ? WHERE id = ?', [Date.now(), 'm2']);
  seed.shutdownAll();

  // Simulate restart: fresh registry.
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const tenants = runBootRecovery(reg, hotDir);
  expect(tenants).toEqual(['urn:t:acme']);
  const h2 = reg.peek('urn:t:acme')!;
  expect([...h2.pendingFlushes.keys()]).toEqual(['c1']);
});

test('recovery on empty hot dir returns empty list', () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  expect(runBootRecovery(reg, hotDir)).toEqual([]);
});

test('recovery is idempotent — running twice does not duplicate state', () => {
  const seed = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const h = seed.get('urn:t:x');
  ensureConversation(h.db, 'c', 'u');
  appendMessage(h.db, { id: 'm', conversationId: 'c', role: 'user', content: 'x', createdAt: 1 });
  seed.shutdownAll();

  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  runBootRecovery(reg, hotDir);
  runBootRecovery(reg, hotDir);
  const h2 = reg.peek('urn:t:x')!;
  expect(h2.pendingFlushes.size).toBe(1);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/recovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement recovery**

Create `/home/joao/augchatd/src/storage/recovery.ts`:

```typescript
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { TenantRegistry } from './tenant-registry';
import { log } from '../log';

export function runBootRecovery(reg: TenantRegistry, hotDir: string): string[] {
  if (!existsSync(hotDir)) return [];
  const files = readdirSync(hotDir).filter((f) => f.endsWith('.sqlite'));
  const tenants: string[] = [];
  for (const f of files) {
    const path = join(hotDir, f);
    const probe = new Database(path, { readonly: true });
    const row = probe
      .query("SELECT value FROM tenant_meta WHERE key='tenant_san_uri'")
      .get() as { value: string } | null;
    probe.close(false);
    if (!row) {
      log.warn('recovery.skipped', 'sqlite file has no tenant_san_uri', { file: f });
      continue;
    }
    const tenantId = row.value;
    const handle = reg.get(tenantId);
    const pendings = handle.db
      .query(
        `SELECT DISTINCT conversation_id AS id FROM messages WHERE flushed_at IS NULL`,
      )
      .all() as { id: string }[];
    let added = 0;
    for (const p of pendings) {
      if (!handle.pendingFlushes.has(p.id)) {
        handle.pendingFlushes.set(p.id, {
          conversationId: p.id,
          nextAttemptAt: Date.now(),
          attemptCount: 0,
          lastError: null,
          inFlight: false,
        });
        added++;
      }
    }
    tenants.push(tenantId);
    log.info('recovery.pending_found', 'unflushed conversations found', {
      tenant_id: tenantId,
      pending_count: pendings.length,
      newly_enqueued: added,
    });
  }
  log.info('recovery.scan', 'boot recovery scan complete', {
    tenant_count: tenants.length,
    hot_dir: hotDir,
  });
  return tenants;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/recovery.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Invoke from `src/index.ts`**

Right after creating the tenant registry, before serving:
```typescript
runBootRecovery(tenantRegistry, cfg.hotDir);
```

- [ ] **Step 6: Commit**

```bash
git add src/storage/recovery.ts tests/storage/recovery.test.ts src/index.ts
git commit -m "feat(storage): boot recovery scan for pending flushes"
```

---

### Task 14: Cold hydration on POST /conversations/{id}/messages

**Files:**
- Create: `src/storage/hydration.ts`
- Create: `tests/storage/hydration.test.ts`
- Modify: `src/server/routes/messages.ts` (invoke hydration before ensureConversation)

Per spec §5.4: if a conversation isn't hot, try `GET meta.json` first; 404 → new conversation. 200 → hydrate from `messages.ndjson` (or zero messages if that 404s). Failure of transport other than 404 → throw an error the route turns into 503 `storage_unreachable`.

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/storage/hydration.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantRegistry } from '../../src/storage/tenant-registry';
import { closeAllDbs } from '../../src/storage/db';
import { listMessages } from '../../src/storage/messages';
import { hydrateConversationIfNeeded } from '../../src/storage/hydration';
import { createFakeS3Client } from '../../src/storage/s3-client';
import { serializeMeta, serializeMessages } from '../../src/storage/ndjson';

let hotDir: string;

const cfg = {
  bucket: 'b',
  prefix: '',
  region: 'us-east-1',
  access_key_id: 'A',
  secret_access_key: 'S',
  force_path_style: false,
};

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-hy-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('returns null when neither meta nor hot exist (new conv)', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const result = await hydrateConversationIfNeeded(reg, s3, cfg, 'urn:t:x', 'u', 'c');
  expect(result).toBeNull();
});

test('hydrates meta + messages into SQLite when both in cold', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const enc = (s: string) => new TextEncoder().encode(s);
  const meta = serializeMeta({ id: 'c', userId: 'u', title: 'hi', createdAt: 1, updatedAt: 2 }, 'cl');
  const msgs = serializeMessages([
    {
      id: 'm1',
      conversationId: 'c',
      role: 'user',
      content: 'a',
      toolCalls: null,
      modelIdUsed: null,
      createdAt: 1,
      flushedAt: null,
      stoppedByUser: false,
      stoppedByShutdown: false,
    },
  ]);
  await s3.put(cfg, 'urn%3At%3Ax/u/c/meta.json', enc(meta), 'application/json');
  await s3.put(cfg, 'urn%3At%3Ax/u/c/messages.ndjson', enc(msgs), 'application/x-ndjson');

  const result = await hydrateConversationIfNeeded(reg, s3, cfg, 'urn:t:x', 'u', 'c');
  expect(result?.userId).toBe('u');
  const h = reg.peek('urn:t:x')!;
  const msgsRow = listMessages(h.db, 'c');
  expect(msgsRow).toHaveLength(1);
  expect(msgsRow[0]!.flushedAt).not.toBeNull(); // marked as already in cold
});

test('meta present but messages 404 → hydrates with zero messages', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const meta = serializeMeta({ id: 'c', userId: 'u', title: null, createdAt: 1, updatedAt: 2 }, null);
  await s3.put(cfg, 'urn%3At%3Ax/u/c/meta.json', new TextEncoder().encode(meta), 'application/json');
  const result = await hydrateConversationIfNeeded(reg, s3, cfg, 'urn:t:x', 'u', 'c');
  expect(result?.userId).toBe('u');
  const h = reg.peek('urn:t:x')!;
  expect(listMessages(h.db, 'c')).toHaveLength(0);
});

test('transport failure (server_error) throws S3Error', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  s3.failNext({ kind: 'server_error', status: 500 });
  await expect(
    hydrateConversationIfNeeded(reg, s3, cfg, 'urn:t:x', 'u', 'c'),
  ).rejects.toMatchObject({ kind: 'server_error' });
});

test('does nothing if conversation already exists hot', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const h = reg.get('urn:t:x');
  h.db.run(
    'INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ['c', 'u', 1, 2],
  );
  const result = await hydrateConversationIfNeeded(reg, s3, cfg, 'urn:t:x', 'u', 'c');
  expect(result?.userId).toBe('u');
  // No S3 traffic
  expect(s3.inspect().size).toBe(0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/hydration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement hydration**

Create `/home/joao/augchatd/src/storage/hydration.ts`:

```typescript
import type { TenantRegistry } from './tenant-registry';
import { type S3Client, isS3Error } from './s3-client';
import type { S3Config } from '../config/session-schema';
import { getConversation } from './conversations';
import { appendMessage } from './messages';
import { parseMeta, parseMessages } from './ndjson';
import { conversationS3Keys } from './cold-delete';
import { log } from '../log';

export interface HydrationResult {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export async function hydrateConversationIfNeeded(
  reg: TenantRegistry,
  s3: S3Client,
  cfg: S3Config,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<HydrationResult | null> {
  const handle = reg.get(tenantId);
  const hot = getConversation(handle.db, conversationId);
  if (hot) {
    return { id: hot.id, userId: hot.userId, title: hot.title, createdAt: hot.createdAt, updatedAt: hot.updatedAt };
  }
  const [metaKey, msgsKey] = conversationS3Keys(tenantId, userId, conversationId);
  let metaText: string;
  try {
    const got = await s3.get(cfg, metaKey);
    metaText = new TextDecoder().decode(got.body);
  } catch (e) {
    if (isS3Error(e) && e.kind === 'not_found') return null;
    throw e;
  }
  const meta = parseMeta(metaText);
  if (meta.userId !== userId) {
    // Different owner — refuse to hydrate cross-user.
    log.warn('hydration.user_mismatch', 'meta.json user_id does not match requester', {
      tenant_id: tenantId,
      conversation_id: conversationId,
      requested_user: userId,
      meta_user: meta.userId,
    });
    return null;
  }
  handle.db.run(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at, default_model) VALUES (?, ?, ?, ?, ?, ?)',
    [meta.id, meta.userId, meta.title, meta.createdAt, meta.updatedAt, meta.defaultModel],
  );
  let msgsText = '';
  try {
    const got = await s3.get(cfg, msgsKey);
    msgsText = new TextDecoder().decode(got.body);
  } catch (e) {
    if (!(isS3Error(e) && e.kind === 'not_found')) throw e;
  }
  const messages = msgsText ? parseMessages(msgsText, meta.id) : [];
  const now = Date.now();
  for (const m of messages) {
    appendMessage(handle.db, m);
    // Mark as already in cold (already flushed):
    handle.db.run('UPDATE messages SET flushed_at = ? WHERE id = ?', [now, m.id]);
  }
  log.info('hydration.completed', 'conversation hydrated from cold', {
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_count: messages.length,
  });
  return {
    id: meta.id,
    userId: meta.userId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}
```

- [ ] **Step 4: Wire into POST messages route**

In `src/server/routes/messages.ts`, before `ensureConversation`:

```typescript
try {
  if (session.storage) {
    await hydrateConversationIfNeeded(
      ctx.tenantRegistry, ctx.s3, session.storage.s3,
      session.tenantId, session.userId, conversationId,
    );
  }
} catch (e) {
  if (isS3Error(e)) {
    return c.json({ error: 'storage_unreachable', detail: { endpoint_host: e.endpointHost, kind: e.kind } }, 503);
  }
  throw e;
}
```

Add `s3: S3Client` and `tenantRegistry` to `AppCtx`.

- [ ] **Step 5: Run, verify pass**

Run: `bun test tests/storage/hydration.test.ts`
Expected: 5 passing.

Run: `bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/storage/hydration.ts tests/storage/hydration.test.ts src/server/routes/messages.ts src/server/app.ts src/index.ts
git commit -m "feat(storage): cold→hot hydration on POST /messages"
```

---

### Task 15: DELETE conversation cascades to S3 prefix

**Files:**
- Modify: `src/server/routes/conversations.ts`
- Modify: `tests/server/routes/conversations.test.ts`

Per spec §5.4: DELETE /conversations/{id} also issues cold delete (best-effort, after the 204 response — fire-and-forget, or before but ignoring errors). We'll do "before but ignoring errors" so a single in-process call is enough; logs surface failures.

- [ ] **Step 1: Add test for cold delete invocation**

Append to `/home/joao/augchatd/tests/server/routes/conversations.test.ts`:

```typescript
import { createFakeS3Client } from '../../../src/storage/s3-client';
import { createTenantRegistry } from '../../../src/storage/tenant-registry';
import { ensureConversation } from '../../../src/storage/conversations';
import { appendMessage } from '../../../src/storage/messages';

test('DELETE /conversations/{id} removes hot rows AND issues cold delete', async () => {
  const reg = createTenantRegistry({ hotDir, idleCloseSeconds: 60 });
  const s3 = createFakeS3Client();
  const cfg = {
    bucket: 'b',
    prefix: '',
    region: 'us-east-1',
    access_key_id: 'A',
    secret_access_key: 'S',
    force_path_style: false,
  };
  await s3.put(cfg, 'urn%3At%3Ax/u/c/meta.json', new Uint8Array([1]), 'application/json');
  await s3.put(cfg, 'urn%3At%3Ax/u/c/messages.ndjson', new Uint8Array([2]), 'application/x-ndjson');
  const h = reg.get('urn:t:x');
  ensureConversation(h.db, 'c', 'u');
  appendMessage(h.db, { id: 'm1', conversationId: 'c', role: 'user', content: 'x', createdAt: 1 });

  // Build app context with our fake S3, then DELETE.
  // (Adapt to whatever appCtx() helper your test suite uses.)
  const app = buildAppForTest({ reg, s3 /* session and others */ });
  const res = await app.request('/conversations/c', { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
  expect(res.status).toBe(204);
  // Cold keys gone
  expect(s3.inspect().size).toBe(0);
});
```

(The exact shape of `buildAppForTest` depends on how Fatia 1 set up its test harness. If Fatia 1 hard-codes a single `app` factory, factor it now to accept `tenantRegistry` and `s3` as optional overrides.)

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/conversations.test.ts`
Expected: FAIL (cold keys still present after DELETE).

- [ ] **Step 3: Modify DELETE handler**

In `src/server/routes/conversations.ts`, the DELETE handler currently runs `deleteConversation(db, id, userId)`. Wrap it with cold delete:

```typescript
import { deleteConversationCold } from '../../storage/cold-delete';

// inside the DELETE handler, after deleteConversation succeeds:
const session = c.get('session');
if (session.storage) {
  await deleteConversationCold(
    ctx.s3,
    session.storage.s3,
    session.tenantId,
    session.userId,
    id,
  );
}
return c.body(null, 204);
```

`deleteConversationCold` already swallows non-404 errors after logging.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/conversations.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/conversations.ts tests/server/routes/conversations.test.ts
git commit -m "feat(server): DELETE /conversations cascades to S3 prefix"
```

---

### Task 16: mTLS test fixtures + generation script

**Files:**
- Create: `scripts/gen-test-certs.sh`
- Create: `tests/fixtures/mtls/*.crt`, `*.key` (committed test material — never used in prod)

The script generates a test CA, a server cert (CN `localhost`, SAN DNS `localhost`), and four client certs:
- `client-acme`: SAN URI `urn:augchatd-tenant:acme`
- `client-beta`: SAN URI `urn:augchatd-tenant:beta`
- `client-no-san`: zero SAN URIs
- `client-multi-san`: two SAN URIs (`urn:augchatd-tenant:a`, `urn:augchatd-tenant:b`)

- [ ] **Step 1: Create generation script**

Create `/home/joao/augchatd/scripts/gen-test-certs.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/mtls"
mkdir -p "$out"
cd "$out"

# Reset
rm -f ./*.crt ./*.key ./*.csr ./*.cnf

# CA
openssl genrsa -out ca.key 2048
openssl req -x509 -new -key ca.key -days 3650 -subj "/CN=augchatd-test-ca" -out ca.crt

# Server cert
openssl genrsa -out server.key 2048
cat > server.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = localhost
[ext]
subjectAltName = DNS:localhost
EOF
openssl req -new -key server.key -config server.cnf -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -extensions ext -extfile server.cnf -out server.crt -days 3650

issue_client() {
  local name="$1" sans="$2"
  openssl genrsa -out "client-${name}.key" 2048
  cat > "client-${name}.cnf" <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = client-${name}
[ext]
subjectAltName = ${sans}
EOF
  openssl req -new -key "client-${name}.key" -config "client-${name}.cnf" -out "client-${name}.csr"
  openssl x509 -req -in "client-${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -extensions ext -extfile "client-${name}.cnf" -out "client-${name}.crt" -days 3650
}

issue_client acme       "URI:urn:augchatd-tenant:acme"
issue_client beta       "URI:urn:augchatd-tenant:beta"
issue_client multi-san  "URI:urn:augchatd-tenant:a,URI:urn:augchatd-tenant:b"

# Client with zero URI SANs (we still need a SAN section because OpenSSL requires non-empty;
# use DNS only).
openssl genrsa -out client-no-san.key 2048
cat > client-no-san.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = client-no-san
[ext]
subjectAltName = DNS:example.com
EOF
openssl req -new -key client-no-san.key -config client-no-san.cnf -out client-no-san.csr
openssl x509 -req -in client-no-san.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -extensions ext -extfile client-no-san.cnf -out client-no-san.crt -days 3650

rm -f ./*.csr ./*.cnf ./*.srl

echo "Generated test certs in $out"
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x scripts/gen-test-certs.sh
./scripts/gen-test-certs.sh
```

Expected output: `Generated test certs in <repo>/tests/fixtures/mtls`.
Verify with: `ls tests/fixtures/mtls/`.

- [ ] **Step 3: Spot-check a cert**

Run: `openssl x509 -in tests/fixtures/mtls/client-acme.crt -noout -text | grep -A1 'Subject Alternative Name'`
Expected: `URI:urn:augchatd-tenant:acme`.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-test-certs.sh tests/fixtures/mtls/
git commit -m "test: mTLS fixtures (test CA + server + 4 client variants)"
```

---

### Task 17: SAN URI extraction utility

**Files:**
- Create: `src/auth/san-uri.ts`
- Create: `tests/auth/san-uri.test.ts`

Per spec §4.6: extract exactly one `URI:` SAN from a peer certificate. Zero or multiple URI SANs → throw with categorized code.

Bun's `Bun.serve({ tls })` provides peer cert info via `Request#tls` or via `Bun.peerCertificate(req)`. The exact API differs across Bun versions — abstract behind a `getPeerCertificate(req)` helper.

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/auth/san-uri.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSingleSanUri, type PeerCertLike } from '../../src/auth/san-uri';

const fixtureDir = join(import.meta.dir, '..', 'fixtures', 'mtls');

function load(name: string): PeerCertLike {
  // bun:tls returns subjectaltname like 'URI:urn:t:x, DNS:y'
  const txt = readFileSync(join(fixtureDir, name + '.crt'), 'utf8');
  return { rawCertPem: txt };
}

test('client-acme yields urn:augchatd-tenant:acme', () => {
  const id = extractSingleSanUri(load('client-acme'));
  expect(id).toBe('urn:augchatd-tenant:acme');
});

test('client-no-san throws tenant_san_ambiguous (count=0)', () => {
  try {
    extractSingleSanUri(load('client-no-san'));
    throw new Error('expected throw');
  } catch (e) {
    expect((e as { code: string; count: number }).code).toBe('tenant_san_ambiguous');
    expect((e as { code: string; count: number }).count).toBe(0);
  }
});

test('client-multi-san throws tenant_san_ambiguous (count=2)', () => {
  try {
    extractSingleSanUri(load('client-multi-san'));
    throw new Error('expected throw');
  } catch (e) {
    expect((e as { code: string; count: number }).count).toBe(2);
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/auth/san-uri.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement extractor**

Create `/home/joao/augchatd/src/auth/san-uri.ts`:

```typescript
/**
 * We accept a thin shape so the same function works against:
 *   - parsed peer cert objects from Bun.serve TLS info (have `subjectaltname` string)
 *   - raw PEM (for tests that load fixtures from disk)
 */
export interface PeerCertLike {
  subjectaltname?: string; // e.g. "URI:urn:t:x, DNS:host"
  rawCertPem?: string;     // PEM body
}

export class TenantSanError extends Error {
  code = 'tenant_san_ambiguous' as const;
  count: number;
  constructor(count: number) {
    super(`expected exactly one SAN URI, got ${count}`);
    this.count = count;
  }
}

function extractFromString(s: string): string[] {
  return s
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('URI:'))
    .map((part) => part.slice(4));
}

function extractFromPem(pem: string): string[] {
  // Minimal parser: pipe through openssl-style ASN.1 reads is overkill; use a regex on
  // the human-readable section if available. For test certs we re-shell to openssl via
  // Bun's spawn. This keeps the production path simple (production passes subjectaltname
  // string directly).
  const proc = Bun.spawnSync({
    cmd: ['openssl', 'x509', '-noout', '-ext', 'subjectAltName'],
    stdin: new TextEncoder().encode(pem),
  });
  const out = new TextDecoder().decode(proc.stdout);
  // out looks like:
  //   X509v3 Subject Alternative Name:
  //       URI:urn:t:x, DNS:host
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  // The line after the header has the values.
  const idx = lines.findIndex((l) => l.startsWith('X509v3 Subject Alternative Name'));
  if (idx < 0) return [];
  const values = lines[idx + 1] ?? '';
  return extractFromString(values);
}

export function extractSingleSanUri(cert: PeerCertLike): string {
  let uris: string[];
  if (typeof cert.subjectaltname === 'string') {
    uris = extractFromString(cert.subjectaltname);
  } else if (typeof cert.rawCertPem === 'string') {
    uris = extractFromPem(cert.rawCertPem);
  } else {
    throw new TenantSanError(0);
  }
  if (uris.length !== 1) {
    throw new TenantSanError(uris.length);
  }
  return uris[0]!;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/auth/san-uri.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/auth/san-uri.ts tests/auth/san-uri.test.ts
git commit -m "feat(auth): extract single SAN URI from peer cert (count != 1 throws)"
```

---

### Task 18: mTLS middleware — populate tenant_id on Hono context

**Files:**
- Create: `src/server/middleware/mtls.ts`
- Create: `tests/server/middleware/mtls.test.ts`

Middleware runs on the CONTROL Hono app. It reads the peer cert from Bun's request context (via `c.req.raw` — Bun exposes `socket.getPeerCertificate()` indirectly; we adapt via the abstraction). Sets `c.set('tenantId', ...)`. On failure: 400 `tenant_san_ambiguous`.

For tests, we inject the peer cert lookup function so we don't need a real TLS handshake.

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/server/middleware/mtls.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { mtlsMiddleware } from '../../../src/server/middleware/mtls';

test('middleware sets tenantId from injected peer cert', async () => {
  const app = new Hono();
  app.use('*', mtlsMiddleware({ getPeerCert: () => ({ subjectaltname: 'URI:urn:augchatd-tenant:acme, DNS:x' }) }));
  app.get('/probe', (c) => c.json({ tenant: c.get('tenantId') }));
  const res = await app.request('/probe');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tenant: 'urn:augchatd-tenant:acme' });
});

test('middleware returns 400 tenant_san_ambiguous when zero URIs', async () => {
  const app = new Hono();
  app.use('*', mtlsMiddleware({ getPeerCert: () => ({ subjectaltname: 'DNS:only' }) }));
  app.get('/probe', (c) => c.text('ok'));
  const res = await app.request('/probe');
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'tenant_san_ambiguous', detail: { count: 0 } });
});

test('middleware returns 400 tls_required when peer cert is missing', async () => {
  const app = new Hono();
  app.use('*', mtlsMiddleware({ getPeerCert: () => null }));
  app.get('/probe', (c) => c.text('ok'));
  const res = await app.request('/probe');
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'tls_required' });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/middleware/mtls.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement middleware**

Create `/home/joao/augchatd/src/server/middleware/mtls.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { extractSingleSanUri, TenantSanError, type PeerCertLike } from '../../auth/san-uri';

export interface MtlsMiddlewareOptions {
  getPeerCert(req: Request): PeerCertLike | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    tenantId: string;
  }
}

export function mtlsMiddleware(opts: MtlsMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const cert = opts.getPeerCert(c.req.raw);
    if (!cert) return c.json({ error: 'tls_required' }, 400);
    try {
      const tenantId = extractSingleSanUri(cert);
      c.set('tenantId', tenantId);
    } catch (e) {
      if (e instanceof TenantSanError) {
        return c.json({ error: 'tenant_san_ambiguous', detail: { count: e.count } }, 400);
      }
      throw e;
    }
    await next();
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/middleware/mtls.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/mtls.ts tests/server/middleware/mtls.test.ts
git commit -m "feat(server): mTLS middleware sets tenantId from peer SAN URI"
```

---

### Task 19: POST /sessions endpoint (control plane)

**Files:**
- Create: `src/server/routes/sessions.ts`
- Create: `tests/server/routes/sessions.test.ts`

Per spec §4.2.1 + §4.4: validate body via `SessionPayloadSchema`, run S3 smoke test, mint JWT, register session entry, return `{session_id, jwt, expires_at}`. Errors: `validation_error`, `unsupported_field`, `storage_unreachable`.

The smoke test = write `<prefix>.augchatd-setup-<random>.json` with a tiny body, read it back, delete it. Categorize errors per spec §4.4.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/routes/sessions.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { sessionsRoutes } from '../../../src/server/routes/sessions';
import { createSessionStore } from '../../../src/auth/sessions';
import { createJwtModule } from '../../../src/auth/jwt';
import { createFakeS3Client } from '../../../src/storage/s3-client';

const KEY = new TextEncoder().encode('A'.repeat(32));

function appWithTenant(tenant: string) {
  const sessions = createSessionStore({});
  const jwt = createJwtModule({ currentKey: KEY, ttlSeconds: 60 });
  const s3 = createFakeS3Client();
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('tenantId', tenant); await next(); });
  app.route('/', sessionsRoutes({ sessions, jwt, s3 }));
  return { app, sessions, s3 };
}

const validBody = {
  user_id: 'u1',
  model: { provider: 'anthropic', model_id: 'cl', api_key: 'k' },
  storage: {
    s3: { bucket: 'b', region: 'us-east-1', access_key_id: 'A', secret_access_key: 'S' },
  },
};

test('POST /sessions returns session_id + jwt + expires_at on success', async () => {
  const { app, sessions, s3 } = appWithTenant('urn:t:acme');
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.session_id).toBe('string');
  expect(typeof body.jwt).toBe('string');
  expect(typeof body.expires_at).toBe('number');
  // session is registered
  expect(sessions.get(body.session_id)?.tenantId).toBe('urn:t:acme');
  // smoke test temp object was cleaned up
  expect(s3.inspect().size).toBe(0);
});

test('POST /sessions rejects mcp_servers with unsupported_field', async () => {
  const { app } = appWithTenant('urn:t:acme');
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validBody, mcp_servers: [] }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('unsupported_field');
});

test('POST /sessions returns validation_error on missing field', async () => {
  const { app } = appWithTenant('urn:t:acme');
  const { storage: _, ...without } = validBody;
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(without),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('validation_error');
});

test('POST /sessions returns storage_unreachable when smoke test fails', async () => {
  const { app, s3 } = appWithTenant('urn:t:acme');
  s3.failNext({ kind: 'auth', status: 403 });
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('storage_unreachable');
  expect(body.detail.kind).toBe('auth');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

Create `/home/joao/augchatd/src/server/routes/sessions.ts`:

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { SessionPayloadSchema, type SessionPayload } from '../../config/session-schema';
import type { SessionStore, SessionEntry } from '../../auth/sessions';
import type { JwtModule } from '../../auth/jwt';
import type { S3Client, S3Error } from '../../storage/s3-client';
import { isS3Error } from '../../storage/s3-client';
import { log } from '../../log';

export interface SessionsRouteOptions {
  sessions: SessionStore;
  jwt: JwtModule;
  s3: S3Client;
  ttlSeconds?: number;
}

async function smokeTestS3(s3: S3Client, payload: SessionPayload): Promise<void> {
  const cfg = payload.storage.s3;
  const key = `.augchatd-setup-${crypto.randomUUID()}.json`;
  const body = new TextEncoder().encode(JSON.stringify({ ts: Date.now() }));
  await s3.put(cfg, key, body, 'application/json');
  await s3.get(cfg, key);
  await s3.delete(cfg, key);
}

export function sessionsRoutes(opts: SessionsRouteOptions): Hono {
  const app = new Hono();
  const ttl = opts.ttlSeconds ?? 600;

  app.post('/sessions', async (c) => {
    const tenantId = c.get('tenantId');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'validation_error', detail: { reason: 'invalid_json' } }, 400);
    }
    let payload: SessionPayload;
    try {
      payload = SessionPayloadSchema.parse(raw);
    } catch (e) {
      const zerr = e as z.ZodError;
      const issue = zerr.errors?.[0];
      const isUnknown = issue?.code === 'unrecognized_keys';
      if (isUnknown) {
        const field = (issue as z.ZodIssue & { keys?: string[] }).keys?.[0] ?? 'unknown';
        return c.json({ error: 'unsupported_field', detail: { field } }, 400);
      }
      return c.json({
        error: 'validation_error',
        detail: { path: issue?.path?.join('.') ?? null, code: issue?.code ?? null },
      }, 400);
    }

    try {
      await smokeTestS3(opts.s3, payload);
    } catch (e) {
      if (isS3Error(e)) {
        return c.json({
          error: 'storage_unreachable',
          detail: { endpoint_host: e.endpointHost, kind: e.kind },
        }, 400);
      }
      throw e;
    }

    const sid = crypto.randomUUID();
    const now = Date.now();
    const entry: SessionEntry = {
      tenantId,
      userId: payload.user_id,
      modelProvider: payload.model.provider,
      modelId: payload.model.model_id,
      modelApiKey: payload.model.api_key,
      systemPrompt: payload.system_prompt,
      storage: { s3: payload.storage.s3 },
      expiresAt: now + ttl * 1000,
      createdAt: now,
      stale: false,
      conversationsTouched: new Set<string>(),
    };
    opts.sessions.put(sid, entry);
    const jwtStr = await opts.jwt.sign({ sub: payload.user_id, aud: tenantId, sid });
    log.info('session.created', 'session minted', {
      session_id: sid,
      tenant_id: tenantId,
      user_id: payload.user_id,
    });
    return c.json({
      session_id: sid,
      jwt: jwtStr,
      expires_at: Math.floor(entry.expiresAt / 1000),
    });
  });

  app.delete('/sessions/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const entry = opts.sessions.get(id);
    if (!entry) return c.json({ error: 'session_not_found' }, 404);
    if (entry.tenantId !== tenantId) return c.json({ error: 'tenant_mismatch' }, 403);
    opts.sessions.delete(id);
    return c.body(null, 204);
  });

  return app;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/sessions.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sessions.ts tests/server/routes/sessions.test.ts
git commit -m "feat(server): POST/DELETE /sessions control plane endpoints"
```

---

### Task 20: DELETE /sessions/{id} — add coverage for cross-tenant + missing

**Files:**
- Modify: `tests/server/routes/sessions.test.ts`

DELETE behaviour is already implemented in Task 19; this task hardens the test coverage and adds the "in-flight requests complete" case (which is just a consequence of the closure-capture pattern from Fatia 1's middleware).

- [ ] **Step 1: Append tests**

Append to `tests/server/routes/sessions.test.ts`:

```typescript
test('DELETE /sessions/{id} returns 204 and evicts entry', async () => {
  const { app, sessions } = appWithTenant('urn:t:acme');
  const post = await app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  const { session_id } = await post.json();
  const del = await app.request(`/sessions/${session_id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(sessions.get(session_id)).toBeUndefined();
});

test('DELETE /sessions/{id} returns 404 when unknown', async () => {
  const { app } = appWithTenant('urn:t:acme');
  const res = await app.request('/sessions/does-not-exist', { method: 'DELETE' });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('session_not_found');
});

test('DELETE /sessions/{id} returns 403 on tenant mismatch', async () => {
  // First mint a session for acme, then try to delete it as beta.
  const acme = appWithTenant('urn:t:acme');
  const beta = appWithTenant('urn:t:beta');
  const post = await acme.app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  const { session_id } = await post.json();
  // Manually plumb acme's session into beta's store to simulate shared in-memory store.
  beta.sessions.put(session_id, acme.sessions.get(session_id)!);
  const del = await beta.app.request(`/sessions/${session_id}`, { method: 'DELETE' });
  expect(del.status).toBe(403);
  expect((await del.json()).error).toBe('tenant_mismatch');
});
```

- [ ] **Step 2: Run, verify pass**

Run: `bun test tests/server/routes/sessions.test.ts`
Expected: 7 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/server/routes/sessions.test.ts
git commit -m "test: cover DELETE /sessions tenant mismatch + 404"
```

---

### Task 21: `shutting_down` middleware

**Files:**
- Create: `src/server/middleware/shutting-down.ts`
- Create: `tests/server/middleware/shutting-down.test.ts`

Per spec §4.4: while graceful shutdown is in progress, new requests respond `503 {"error": "shutting_down"}`. Streams already open are allowed to finish (the middleware checks only at request start).

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/server/middleware/shutting-down.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { createShutdownFlag, shuttingDownMiddleware } from '../../../src/server/middleware/shutting-down';

test('middleware passes through when not shutting down', async () => {
  const flag = createShutdownFlag();
  const app = new Hono();
  app.use('*', shuttingDownMiddleware(flag));
  app.get('/x', (c) => c.text('ok'));
  const res = await app.request('/x');
  expect(res.status).toBe(200);
});

test('middleware returns 503 once flag is set', async () => {
  const flag = createShutdownFlag();
  const app = new Hono();
  app.use('*', shuttingDownMiddleware(flag));
  app.get('/x', (c) => c.text('ok'));
  flag.markShuttingDown();
  const res = await app.request('/x');
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'shutting_down' });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/middleware/shutting-down.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement middleware + flag**

Create `/home/joao/augchatd/src/server/middleware/shutting-down.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';

export interface ShutdownFlag {
  isShuttingDown(): boolean;
  markShuttingDown(): void;
}

export function createShutdownFlag(): ShutdownFlag {
  let down = false;
  return {
    isShuttingDown: () => down,
    markShuttingDown: () => { down = true; },
  };
}

export function shuttingDownMiddleware(flag: ShutdownFlag): MiddlewareHandler {
  return async (c, next) => {
    if (flag.isShuttingDown()) {
      return c.json({ error: 'shutting_down' }, 503);
    }
    await next();
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/middleware/shutting-down.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/shutting-down.ts tests/server/middleware/shutting-down.test.ts
git commit -m "feat(server): shutting_down middleware (503 during drain)"
```

---

### Task 22: Graceful shutdown coordinator

**Files:**
- Create: `src/server/shutdown.ts`
- Create: `tests/server/shutdown.test.ts`

Per spec §G (graceful shutdown): set the flag, wait deadline for in-flight streams, mark partials, run `flushQueue.flushAllNow()`, then `tenantRegistry.shutdownAll()`. Coordinator is testable in isolation by injecting collaborators.

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/server/shutdown.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createShutdownFlag } from '../../src/server/middleware/shutting-down';
import { runGracefulShutdown } from '../../src/server/shutdown';

test('shutdown coordinator runs steps in order', async () => {
  const calls: string[] = [];
  const flag = createShutdownFlag();
  await runGracefulShutdown({
    flag,
    deadlineMs: 50,
    waitForInflight: async () => { calls.push('drain'); },
    markPartials: () => { calls.push('mark'); },
    flushAllNow: async () => { calls.push('flush'); },
    closeTenants: () => { calls.push('close'); },
    closeFlushQueue: () => { calls.push('queue'); },
    closeGc: () => { calls.push('gc'); },
  });
  expect(flag.isShuttingDown()).toBe(true);
  expect(calls).toEqual(['drain', 'mark', 'flush', 'queue', 'gc', 'close']);
});

test('shutdown applies deadline to drain step', async () => {
  const flag = createShutdownFlag();
  const start = Date.now();
  await runGracefulShutdown({
    flag,
    deadlineMs: 50,
    waitForInflight: async () => { await Bun.sleep(500); },
    markPartials: () => {},
    flushAllNow: async () => {},
    closeTenants: () => {},
    closeFlushQueue: () => {},
    closeGc: () => {},
  });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(450); // drain truncated
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/shutdown.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement coordinator**

Create `/home/joao/augchatd/src/server/shutdown.ts`:

```typescript
import { log } from '../log';
import type { ShutdownFlag } from './middleware/shutting-down';

export interface ShutdownDeps {
  flag: ShutdownFlag;
  deadlineMs: number;
  waitForInflight(signal: AbortSignal): Promise<void>;
  markPartials(): void;
  flushAllNow(): Promise<void>;
  closeFlushQueue(): void;
  closeGc(): void;
  closeTenants(): void;
}

export async function runGracefulShutdown(deps: ShutdownDeps): Promise<void> {
  deps.flag.markShuttingDown();
  log.info('shutdown.start', 'graceful shutdown initiated', { deadline_ms: deps.deadlineMs });

  // Step 1: drain in-flight streams with deadline.
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), deps.deadlineMs);
  try {
    await deps.waitForInflight(ac.signal);
  } catch (e) {
    log.warn('shutdown.drain_aborted', 'drain hit deadline', { reason: (e as Error).message });
  } finally {
    clearTimeout(deadline);
  }

  deps.markPartials();
  await deps.flushAllNow();
  deps.closeFlushQueue();
  deps.closeGc();
  deps.closeTenants();
  log.info('shutdown.complete', 'graceful shutdown finished', {});
}
```

`waitForInflight` is wired in `src/index.ts` to track active streams; for now the simplest impl: maintain a counter incremented at request entry, decremented at exit; `waitForInflight` polls with backoff until counter is 0 or signal aborts.

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/shutdown.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/shutdown.ts tests/server/shutdown.test.ts
git commit -m "feat(server): graceful shutdown coordinator"
```

---

### Task 23: Production boot — two-port serve, signals, shutdown wiring

**Files:**
- Modify: `src/index.ts`

Pulls everything together. In `mode=prod`, open two `Bun.serve` instances; in `mode=demo`, only the data plane.

For Bun's TLS API:
- The control server uses `tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true }`.
- Bun exposes peer cert via `server.requestIP(req)` and `req` augmented with TLS info. The current portable API is `Bun.peerCertificate(req)` (Bun ≥ 1.1.43). Wrap behind a function so tests can mock.

- [ ] **Step 1: Replace `src/index.ts`**

Replace `/home/joao/augchatd/src/index.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { parseEnv } from './config/env';
import { buildDemoSession } from './config/demo';
import { createJwtModule } from './auth/jwt';
import { createSessionStore } from './auth/sessions';
import { createTenantRegistry } from './storage/tenant-registry';
import { createBunS3Client } from './storage/s3-client';
import { createFlushQueue } from './storage/flush-queue';
import { startGcLoop } from './storage/gc';
import { runBootRecovery } from './storage/recovery';
import { makeOnEvict } from './storage/eviction-wiring';
import { createDataApp, createControlApp } from './server/app';
import { createShutdownFlag } from './server/middleware/shutting-down';
import { runGracefulShutdown } from './server/shutdown';
import { log } from './log';

const cfg = parseEnv(process.env);

const tenantRegistry = createTenantRegistry({
  hotDir: cfg.hotDir,
  idleCloseSeconds: cfg.tenantIdleCloseSeconds,
});

const s3 = createBunS3Client();

// session store and flush queue need to know about each other; late-bind.
let queueRef: ReturnType<typeof createFlushQueue> | undefined;
const sessions = createSessionStore({
  onEvict: (sid, e, r) => queueRef && makeOnEvict(queueRef)(sid, e, r),
});
queueRef = createFlushQueue({
  s3, sessions, tenantRegistry,
  backoffCapSeconds: cfg.flushBackoffCapSeconds,
  idleFlushSeconds: cfg.flushIdleSeconds,
});
const queue = queueRef;
queue.start();

const gc = startGcLoop(tenantRegistry, { delaySeconds: cfg.gcDelaySeconds });

runBootRecovery(tenantRegistry, cfg.hotDir);

const jwt = createJwtModule({
  currentKey: cfg.jwt.currentKey,
  previousKey: cfg.jwt.previousKey,
  ttlSeconds: cfg.jwt.ttlSeconds,
});

if (cfg.mode === 'demo') {
  const payload = buildDemoSession(process.env);
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 365;
  sessions.put('demo', {
    tenantId: 'urn:augchatd-tenant:demo',
    userId: payload.user_id,
    modelProvider: payload.model.provider,
    modelId: payload.model.model_id,
    modelApiKey: payload.model.api_key,
    systemPrompt: payload.system_prompt,
    storage: payload.storage ? { s3: payload.storage.s3 } : undefined,
    expiresAt,
    createdAt: Date.now(),
    stale: false,
    conversationsTouched: new Set<string>(),
  });
}

const shutdownFlag = createShutdownFlag();

// In-flight tracker
let inflight = 0;
const inflightInc = (): void => { inflight++; };
const inflightDec = (): void => { inflight--; };

const dataApp = createDataApp({
  config: cfg, sessions, jwt, s3, tenantRegistry, flushQueue: queue, shutdownFlag,
  inflightInc, inflightDec,
});

const controlApp = cfg.mode === 'prod'
  ? createControlApp({
      sessions, jwt, s3, shutdownFlag,
      ttlSeconds: cfg.jwt.ttlSeconds,
    })
  : undefined;

const dataServer = Bun.serve({
  hostname: cfg.listenData.host,
  port: cfg.listenData.port,
  fetch: dataApp.fetch,
  ...(cfg.dataTls
    ? { tls: { cert: readFileSync(cfg.dataTls.certFile), key: readFileSync(cfg.dataTls.keyFile) } }
    : {}),
});
log.info('serve.data', 'data plane listening', { host: cfg.listenData.host, port: cfg.listenData.port, tls: !!cfg.dataTls });

const controlServer = controlApp && cfg.tls && cfg.listenControl
  ? Bun.serve({
      hostname: cfg.listenControl.host,
      port: cfg.listenControl.port,
      fetch: controlApp.fetch,
      tls: {
        cert: readFileSync(cfg.tls.certFile),
        key: readFileSync(cfg.tls.keyFile),
        ca: readFileSync(cfg.tls.clientCaFile),
        requestCert: true,
        rejectUnauthorized: true,
      },
    })
  : undefined;
if (controlServer) {
  log.info('serve.control', 'control plane listening (mTLS)', { host: cfg.listenControl?.host, port: cfg.listenControl?.port });
}

async function shutdown(reason: string): Promise<void> {
  log.info('signal.received', 'shutdown signal', { reason });
  await runGracefulShutdown({
    flag: shutdownFlag,
    deadlineMs: cfg.shutdownDeadlineSeconds * 1000,
    waitForInflight: async (signal) => {
      while (inflight > 0 && !signal.aborted) {
        await Bun.sleep(50);
      }
    },
    markPartials: () => { /* messages route handler should mark on close; left as the route's job */ },
    flushAllNow: () => queue.flushAllNow(),
    closeFlushQueue: () => queue.stop(),
    closeGc: () => gc.stop(),
    closeTenants: () => tenantRegistry.shutdownAll(),
  });
  dataServer.stop(false);
  controlServer?.stop(false);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
```

- [ ] **Step 2: Split `createApp` into `createDataApp` + `createControlApp`**

In `src/server/app.ts`, export two factories. The data app wires the JWT middleware, demo routes, conversations/messages routes, static UI. The control app wires the mTLS middleware + sessions routes + health/version.

Skeleton:

```typescript
export function createDataApp(deps: DataAppDeps): Hono { ... }

export function createControlApp(deps: ControlAppDeps): Hono {
  const app = new Hono();
  app.use('*', shuttingDownMiddleware(deps.shutdownFlag));
  app.use('*', mtlsMiddleware({ getPeerCert: (req) => readPeerCert(req) }));
  app.route('/', healthRoutes(/* version info */));
  app.route('/', sessionsRoutes({ sessions: deps.sessions, jwt: deps.jwt, s3: deps.s3, ttlSeconds: deps.ttlSeconds }));
  return app;
}
```

`readPeerCert(req)` is a thin wrapper around Bun's peer cert API. Stub:

```typescript
function readPeerCert(req: Request): PeerCertLike | null {
  type BunWithCert = { peerCertificate?(r: Request): { subjectaltname?: string } | null };
  const fn = (globalThis as { Bun?: BunWithCert }).Bun?.peerCertificate;
  if (!fn) return null;
  const cert = fn(req);
  return cert ? { subjectaltname: cert.subjectaltname } : null;
}
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: every suite green.

Run: `bun run typecheck`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/server/app.ts
git commit -m "feat(server): two-port boot, mTLS control plane, signal handlers"
```

---

### Task 24: E2E production test (mTLS + MinIO)

**Files:**
- Create: `docker-compose.test.yml`
- Create: `tests/e2e/prod.test.ts`

End-to-end exercise: start MinIO, generate test creds, fire up augchatd in `mode=prod`, mint a session via mTLS, stream a chat reply, verify cold flush after eviction.

The test relies on an Anthropic API key being available via `ANTHROPIC_API_KEY`. If not set, the test is skipped (logged).

- [ ] **Step 1: Create docker-compose**

Create `/home/joao/augchatd/docker-compose.test.yml`:

```yaml
services:
  minio:
    image: minio/minio:RELEASE.2024-12-01T00-00-00Z
    command: server /data --address ":9000"
    environment:
      MINIO_ROOT_USER: aug-test
      MINIO_ROOT_PASSWORD: aug-test-secret
    ports:
      - "19000:9000"
```

- [ ] **Step 2: Write E2E test**

Create `/home/joao/augchatd/tests/e2e/prod.test.ts`:

```typescript
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const HAS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY;
const fixtureDir = join(import.meta.dir, '..', 'fixtures', 'mtls');

let daemon: Subprocess | undefined;
let hotDir: string;
let minio: Subprocess | undefined;

const wait = async (url: string, attempts = 50): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error('timeout waiting for ' + url);
};

beforeAll(async () => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-e2e-'));
  // Bring up MinIO (assumes docker is installed).
  minio = spawn(['docker', 'compose', '-f', 'docker-compose.test.yml', 'up', '-d', 'minio'], {
    cwd: process.cwd(),
    stdout: 'pipe', stderr: 'pipe',
  });
  await minio.exited;
  await wait('http://localhost:19000/minio/health/ready');

  // Create test bucket via MinIO admin API (mc) or aws-cli; skip if can't.
  const mc = spawn(['docker', 'run', '--rm', '--network=host', 'minio/mc',
    'alias', 'set', 'local', 'http://localhost:19000', 'aug-test', 'aug-test-secret']);
  await mc.exited;
  const mb = spawn(['docker', 'run', '--rm', '--network=host', 'minio/mc',
    'mb', '-p', 'local/augchatd-test']);
  await mb.exited;

  daemon = spawn(['bun', 'run', 'src/index.ts'], {
    env: {
      ...process.env,
      AUGCHATD_MODE: 'prod',
      AUGCHATD_LISTEN_DATA: '127.0.0.1:18080',
      AUGCHATD_LISTEN_CONTROL: '127.0.0.1:18443',
      AUGCHATD_TLS_CERT_FILE: join(fixtureDir, 'server.crt'),
      AUGCHATD_TLS_KEY_FILE: join(fixtureDir, 'server.key'),
      AUGCHATD_CLIENT_CA_FILE: join(fixtureDir, 'ca.crt'),
      AUGCHATD_HOT_DIR: hotDir,
      AUGCHATD_JWT_SIGNING_KEY_CURRENT: Buffer.from('A'.repeat(32)).toString('base64'),
      AUGCHATD_FLUSH_IDLE_SECONDS: '1',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  await wait('http://127.0.0.1:18080/health');
});

afterAll(async () => {
  daemon?.kill('SIGTERM');
  if (daemon) await daemon.exited;
  rmSync(hotDir, { recursive: true, force: true });
  if (minio) {
    const down = spawn(['docker', 'compose', '-f', 'docker-compose.test.yml', 'down', '-v']);
    await down.exited;
  }
});

test.skipIf(!HAS_ANTHROPIC)('mints a session via mTLS, streams a turn, flushes to S3', async () => {
  const cert = readFileSync(join(fixtureDir, 'client-acme.crt'));
  const key = readFileSync(join(fixtureDir, 'client-acme.key'));
  const ca = readFileSync(join(fixtureDir, 'ca.crt'));

  const payload = {
    user_id: 'e2e-user',
    model: { provider: 'anthropic', model_id: 'claude-haiku-4-5-20251001', api_key: process.env.ANTHROPIC_API_KEY },
    storage: {
      s3: {
        bucket: 'augchatd-test',
        region: 'us-east-1',
        endpoint: 'http://localhost:19000',
        access_key_id: 'aug-test',
        secret_access_key: 'aug-test-secret',
        force_path_style: true,
      },
    },
  };

  // POST /sessions via mTLS — Bun.fetch supports tls config in 1.1.43+.
  const res = await fetch('https://127.0.0.1:18443/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    tls: { cert, key, ca, rejectUnauthorized: false, checkServerIdentity: () => undefined },
  });
  expect(res.status).toBe(200);
  const { session_id, jwt } = await res.json();
  expect(typeof session_id).toBe('string');
  expect(typeof jwt).toBe('string');

  // POST message to data plane (plain HTTP in this test setup).
  const convId = crypto.randomUUID();
  const chat = await fetch(`http://127.0.0.1:18080/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ message: 'Say "hi" in one word.' }),
  });
  expect(chat.status).toBe(200);
  // Consume the stream to completion
  const body = await chat.text();
  expect(body.length).toBeGreaterThan(0);

  // Wait for idle flush (AUGCHATD_FLUSH_IDLE_SECONDS=1)
  await Bun.sleep(1500);

  // Verify cold has the two objects
  const mc = spawn(['docker', 'run', '--rm', '--network=host', 'minio/mc',
    'ls', '-r', 'local/augchatd-test'], { stdout: 'pipe' });
  await mc.exited;
  const out = new TextDecoder().decode(await new Response(mc.stdout!).arrayBuffer());
  expect(out).toContain('meta.json');
  expect(out).toContain('messages.ndjson');
});
```

- [ ] **Step 3: Document how to run**

Add a short section to `README.md` or a separate `docs/e2e.md`:
```
# Running E2E tests
Prereq: Docker + ANTHROPIC_API_KEY in env
$ ./scripts/gen-test-certs.sh   # only first time
$ bun test tests/e2e/prod.test.ts
```

- [ ] **Step 4: Run (manual)**

```bash
./scripts/gen-test-certs.sh
ANTHROPIC_API_KEY=$YOUR_KEY bun test tests/e2e/prod.test.ts
```

Expected: 1 passing (or "skipped" if `ANTHROPIC_API_KEY` not set).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.test.yml tests/e2e/prod.test.ts
git commit -m "test(e2e): prod mode end-to-end against MinIO + mTLS"
```

---

### Task 25: Dockerfile + README touchups

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md` (optional; small note about new env vars)

- [ ] **Step 1: Update Dockerfile**

In `/home/joao/augchatd/Dockerfile`, expose 8443 and document mount points. At the bottom of the runtime stage:

```dockerfile
# Control plane (mTLS) port; operator mounts cert/key/CA at these paths:
#   /etc/augchatd/server.crt
#   /etc/augchatd/server.key
#   /etc/augchatd/ca.crt
ENV AUGCHATD_TLS_CERT_FILE=/etc/augchatd/server.crt \
    AUGCHATD_TLS_KEY_FILE=/etc/augchatd/server.key \
    AUGCHATD_CLIENT_CA_FILE=/etc/augchatd/ca.crt

EXPOSE 8080 8443
```

- [ ] **Step 2: Add a small Fatia 2 note to README**

Search the README for `AUGCHATD_LISTEN` and rename mentions to `AUGCHATD_LISTEN_DATA`. Add a sentence near the prod payload example noting that `storage.s3` is the structured form `{bucket, region, ...}`.

Run: `grep -n 'AUGCHATD_LISTEN\b\|"s3":' README.md` and update each hit.

- [ ] **Step 3: Build container locally**

```bash
docker build -t augchatd:dev .
```
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile README.md
git commit -m "chore: expose 8443 + document mTLS mount points; README touchups"
```

---

## Self-review notes (informational; engineer needn't re-run)

- Every spec section §2–§8 has a corresponding task. §4 contracts: ports/env (Task 1), endpoints (Tasks 18–20), JWT (inherited from Fatia 1; `aud` becomes real tenant via Task 19), error codes (Task 19/21), mTLS detail (Tasks 16–18). §5 data: schema (Task 2), session entry (Task 6), NDJSON (Task 5), tenant handle/registry (Task 7), flush queue (Task 9). §6 cluster map and §7 critérios are satisfied by the corresponding tasks (Task 24 covers most of §7 directly).
- The flush queue's `idleFlushSeconds` is wired to `cfg.flushIdleSeconds` in Task 23's boot; Task 11 only exposes the mechanism.
- All `tenantRegistry.peek(tenantId)` calls handle `undefined` (the registry may close handles mid-flight; subsequent code paths short-circuit). Search ensures no `tenantRegistry.peek(...)!` shortcuts in production code outside tests.
- Names referenced across tasks: `createTenantRegistry`, `createFlushQueue`, `createFakeS3Client`, `createBunS3Client`, `runBootRecovery`, `runGcPass`, `startGcLoop`, `hydrateConversationIfNeeded`, `deleteConversationCold`, `conversationS3Keys`, `extractSingleSanUri`, `mtlsMiddleware`, `shuttingDownMiddleware`, `createShutdownFlag`, `runGracefulShutdown`, `sessionsRoutes`, `createDataApp`, `createControlApp`, `makeOnEvict`. Each appears in its defining task and consistently in every callee task.

---

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-05-22-augchatd-fatia-2-producao.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

