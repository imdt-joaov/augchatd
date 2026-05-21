# augchatd — Fatia 1 (MVP demo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up augchatd in demo mode end-to-end: `docker run` (or `bun run start`) boots a process that exposes a bundled chat UI, mints a short-lived JWT from env-configured credentials, persists conversation history to a local SQLite, and streams LLM responses via the Vercel AI SDK data stream protocol — all without mTLS, MCP, RAG, or S3.

**Architecture:** Single-process Bun + Hono daemon. Demo mode loads one fixed session into the in-memory session store at boot (built from env vars validated through the same schema as a production `POST /sessions` payload). A bundled React UI (assistant-ui) is served on the same origin; it gets its JWT from a parent page via `postMessage`, then drives chat via `POST /conversations/{id}/messages` (Vercel AI SDK data stream over SSE). Persistence is hot-only in this fatia — SQLite per tenant on local disk; no S3, no flush, no GC.

**Tech Stack:** Bun ≥ 1.1 (runtime + embedded SQLite + test runner + bundler) · Hono 4 (HTTP) · Vercel AI SDK (`ai`, `@ai-sdk/anthropic`) · `jose` (JWT HS256) · `zod` (config validation) · React 18 + Vite + `@assistant-ui/react` + `@assistant-ui/react-ai-sdk` (UI)

**Source of truth for architectural decisions:** `docs/superpowers/specs/2026-05-21-augchatd-architecture-design.md`. Tasks reference clusters (A–I) from there.

---

## File Structure

Backend:

```
src/
├── index.ts                          # Entry: parse config, boot session, start server
├── log.ts                            # Structured JSON logger
├── config/
│   ├── env.ts                        # Process-level env vars (zod schema)
│   ├── session-schema.ts             # SessionPayload zod schema (shared with future prod path)
│   └── demo.ts                       # Build SessionPayload from DEMO_* env vars
├── auth/
│   ├── jwt.ts                        # Sign/verify HS256 with kid routing
│   └── sessions.ts                   # In-memory session store with TTL + stale flag
├── storage/
│   ├── db.ts                         # Per-tenant SQLite open + schema + WAL
│   ├── conversations.ts              # Conversation repo (create-implicit, list, delete)
│   └── messages.ts                   # Message repo (append, list)
├── chat/
│   └── stream.ts                     # streamText + onFinish persistence
└── server/
    ├── app.ts                        # Hono app factory: routes + middleware
    ├── middleware/
    │   └── jwt-auth.ts               # Bearer parsing, JWT verify, session lookup, stale check
    └── routes/
        ├── health.ts                 # GET /health, GET /version
        ├── demo.ts                   # GET /demo/jwt
        ├── conversations.ts          # GET /conversations, DELETE /conversations/{id}
        ├── messages.ts               # POST /conversations/{id}/messages (streaming)
        └── ui.ts                     # Static serving of built UI from dist/ui/
```

UI:

```
ui/
├── package.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx                      # Entry, mounts <App>
    ├── App.tsx                       # assistant-ui Thread + runtime + sidebar
    ├── parent.ts                     # postMessage protocol (5 messages)
    ├── runtime.ts                    # useChatRuntime adapter with JWT header + 401 handling
    ├── conversations-client.ts       # /conversations API client + localStorage active-conv-id
    └── Sidebar.tsx                   # conversation list + new + delete
```

Tests mirror `src/` under `tests/`, plus `tests/e2e/demo.test.ts`.

Build/runtime:

```
package.json                          # root: backend + UI deps + scripts
tsconfig.json                         # backend
ui/tsconfig.json                      # UI (separate, React JSX)
bunfig.toml                           # test preset, port for dev
Dockerfile                            # multi-stage: build UI, then runtime
.dockerignore
.gitignore
.prettierrc
```

---

## Conventions

- **TDD strictly.** Every code task starts with a failing test, then minimal implementation.
- **One commit per task.** Atomic, builds & tests pass at every commit.
- **No `any` or `as any` in source.** Tests may use it sparingly for mocks.
- **All logs go through `src/log.ts`.** Never raw `console.log` in source (tests OK).
- **Imports use relative paths** (`../auth/jwt`), not aliases. Keeps tsconfig minimal.
- **Bun's test runner** (`bun test`). No vitest/jest.
- **Strings in error responses are categorized codes** (`auth_required`, `session_not_found`, etc.), never raw upstream messages. Cluster D principle.

---

### Task 1: Project bootstrap (package.json, tsconfig, gitignore, prettier)

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.prettierrc`, `.dockerignore`

- [ ] **Step 1: Initialize package.json**

Create `/home/joao/augchatd/package.json`:

```json
{
  "name": "augchatd",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "build:ui": "cd ui && bun run build",
    "typecheck": "bunx tsc --noEmit",
    "build": "bun run typecheck && bun run build:ui && bun build src/index.ts --outdir dist --target bun",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "format": "prettier --write ."
  },
  "dependencies": {
    "hono": "^4.6.0",
    "ai": "^4.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "jose": "^5.9.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Initialize tsconfig.json**

Create `/home/joao/augchatd/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["ui", "dist", "node_modules"]
}
```

- [ ] **Step 3: Create bunfig.toml**

Create `/home/joao/augchatd/bunfig.toml`:

```toml
[test]
preload = []
```

- [ ] **Step 4: Create .gitignore**

Create `/home/joao/augchatd/.gitignore`:

```
node_modules/
dist/
data/
*.log
.env
.env.*
!.env.example
.DS_Store
ui/node_modules/
ui/dist/
```

- [ ] **Step 5: Create .prettierrc**

Create `/home/joao/augchatd/.prettierrc`:

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true
}
```

- [ ] **Step 6: Create .dockerignore**

Create `/home/joao/augchatd/.dockerignore`:

```
node_modules
dist
data
.git
*.log
.env
.env.*
ui/node_modules
ui/dist
docs
```

- [ ] **Step 7: Install dependencies**

Run: `bun install`
Expected: "Done." with no errors. Creates `bun.lockb` and `node_modules/`.

- [ ] **Step 8: Verify TypeScript compiles**

Run: `bunx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore .prettierrc .dockerignore bun.lockb
git commit -m "chore: bootstrap Bun + TypeScript project"
```

---

### Task 2: Structured JSON logger

**Files:**
- Create: `src/log.ts`
- Test: `tests/log.test.ts`

The logger writes one JSON object per line to stderr. Per Cluster I: fields `level`, `ts`, `event`, `msg` always; optional contextual fields (`tenant_id`, `session_id`, `conversation_id`, ...). No log of message bodies, tool results, credentials, MCP URLs, or RAG snippets.

- [ ] **Step 1: Write the failing test**

Create `/home/joao/augchatd/tests/log.test.ts`:

```typescript
import { test, expect, mock } from 'bun:test';
import { createLogger } from '../src/log';

test('logger writes JSON line to stderr with required fields', () => {
  const writes: string[] = [];
  const log = createLogger({ write: (s) => writes.push(s) });
  log.info('session_created', 'demo session loaded', { session_id: 'sid_x' });
  expect(writes).toHaveLength(1);
  const parsed = JSON.parse(writes[0]!);
  expect(parsed.level).toBe('info');
  expect(parsed.event).toBe('session_created');
  expect(parsed.msg).toBe('demo session loaded');
  expect(parsed.session_id).toBe('sid_x');
  expect(typeof parsed.ts).toBe('number');
});

test('logger supports warn, error', () => {
  const writes: string[] = [];
  const log = createLogger({ write: (s) => writes.push(s) });
  log.warn('config_default', 'using default', {});
  log.error('boot_failed', 'unable to start', { reason: 'missing_key' });
  expect(JSON.parse(writes[0]!).level).toBe('warn');
  expect(JSON.parse(writes[1]!).level).toBe('error');
  expect(JSON.parse(writes[1]!).reason).toBe('missing_key');
});

test('logger appends newline', () => {
  const writes: string[] = [];
  const log = createLogger({ write: (s) => writes.push(s) });
  log.info('x', 'y', {});
  expect(writes[0]!.endsWith('\n')).toBe(true);
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `bun test tests/log.test.ts`
Expected: FAIL with "Cannot find module '../src/log'".

- [ ] **Step 3: Implement the logger**

Create `/home/joao/augchatd/src/log.ts`:

```typescript
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, msg: string, fields: Fields): void;
  info(event: string, msg: string, fields: Fields): void;
  warn(event: string, msg: string, fields: Fields): void;
  error(event: string, msg: string, fields: Fields): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((s) => process.stderr.write(s));
  const emit = (level: Level, event: string, msg: string, fields: Fields) => {
    const line = JSON.stringify({ ts: Date.now(), level, event, msg, ...fields }) + '\n';
    write(line);
  };
  return {
    debug: (e, m, f) => emit('debug', e, m, f),
    info: (e, m, f) => emit('info', e, m, f),
    warn: (e, m, f) => emit('warn', e, m, f),
    error: (e, m, f) => emit('error', e, m, f),
  };
}

export const log: Logger = createLogger();
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test tests/log.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts tests/log.test.ts
git commit -m "feat(log): structured JSON logger to stderr"
```

---

### Task 3: Process-level env config parsing

**Files:**
- Create: `src/config/env.ts`
- Test: `tests/config/env.test.ts`

Per Cluster H.1: env vars only. This module parses and validates them; fails fast on boot with a clear message.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/config/env.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { parseEnv } from '../../src/config/env';

const baseDemoEnv = {
  AUGCHATD_MODE: 'demo',
  AUGCHATD_LISTEN: '0.0.0.0:8080',
  AUGCHATD_HOT_DIR: '/tmp/aug-hot',
  AUGCHATD_JWT_SIGNING_KEY_CURRENT: Buffer.from('a'.repeat(32)).toString('base64'),
  DEMO_MODEL_PROVIDER: 'anthropic',
  DEMO_MODEL_ID: 'claude-opus-4-7',
  DEMO_MODEL_API_KEY: 'sk-ant-test',
  DEMO_SYSTEM_PROMPT: 'You are helpful.',
};

test('parses minimal demo env', () => {
  const cfg = parseEnv(baseDemoEnv);
  expect(cfg.mode).toBe('demo');
  expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 8080 });
  expect(cfg.hotDir).toBe('/tmp/aug-hot');
  expect(cfg.jwt.currentKey.byteLength).toBe(32);
  expect(cfg.jwt.previousKey).toBeUndefined();
  expect(cfg.jwt.ttlSeconds).toBe(600);
});

test('JWT previous key parsed when present', () => {
  const env = {
    ...baseDemoEnv,
    AUGCHATD_JWT_SIGNING_KEY_PREVIOUS: Buffer.from('b'.repeat(32)).toString('base64'),
  };
  const cfg = parseEnv(env);
  expect(cfg.jwt.previousKey?.byteLength).toBe(32);
});

test('missing required env throws with clear message', () => {
  const env = { ...baseDemoEnv } as Record<string, string>;
  delete env.AUGCHATD_JWT_SIGNING_KEY_CURRENT;
  expect(() => parseEnv(env)).toThrow(/AUGCHATD_JWT_SIGNING_KEY_CURRENT/);
});

test('listen accepts host:port format', () => {
  const cfg = parseEnv({ ...baseDemoEnv, AUGCHATD_LISTEN: '127.0.0.1:9090' });
  expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 9090 });
});

test('listen rejects malformed value', () => {
  expect(() => parseEnv({ ...baseDemoEnv, AUGCHATD_LISTEN: 'not-a-listen' })).toThrow();
});

test('JWT key shorter than 32 bytes rejected', () => {
  const tooShort = Buffer.from('a'.repeat(16)).toString('base64');
  expect(() =>
    parseEnv({ ...baseDemoEnv, AUGCHATD_JWT_SIGNING_KEY_CURRENT: tooShort }),
  ).toThrow(/at least 32 bytes/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/env.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement parser**

Create `/home/joao/augchatd/src/config/env.ts`:

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

const EnvSchema = z.object({
  AUGCHATD_MODE: z.enum(['demo', 'prod']).default('demo'),
  AUGCHATD_LISTEN: ListenSchema.default('0.0.0.0:8080' as never),
  AUGCHATD_HOT_DIR: z.string().default('/var/lib/augchatd/hot'),
  AUGCHATD_JWT_SIGNING_KEY_CURRENT: Base64Key,
  AUGCHATD_JWT_SIGNING_KEY_PREVIOUS: Base64Key.optional(),
  AUGCHATD_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(600),
});

export interface ProcessConfig {
  mode: 'demo' | 'prod';
  listen: { host: string; port: number };
  hotDir: string;
  jwt: {
    currentKey: Uint8Array;
    previousKey?: Uint8Array;
    ttlSeconds: number;
  };
}

export function parseEnv(env: Record<string, string | undefined>): ProcessConfig {
  const parsed = EnvSchema.parse(env);
  return {
    mode: parsed.AUGCHATD_MODE,
    listen: parsed.AUGCHATD_LISTEN,
    hotDir: parsed.AUGCHATD_HOT_DIR,
    jwt: {
      currentKey: new Uint8Array(parsed.AUGCHATD_JWT_SIGNING_KEY_CURRENT),
      previousKey: parsed.AUGCHATD_JWT_SIGNING_KEY_PREVIOUS
        ? new Uint8Array(parsed.AUGCHATD_JWT_SIGNING_KEY_PREVIOUS)
        : undefined,
      ttlSeconds: parsed.AUGCHATD_JWT_TTL_SECONDS,
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/env.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts
git commit -m "feat(config): parse process-level env vars via zod"
```

---

### Task 4: Session payload schema (shared between demo and future prod)

**Files:**
- Create: `src/config/session-schema.ts`
- Test: `tests/config/session-schema.test.ts`

Per Cluster H.3: demo builds an "as-if `POST /sessions`" payload and validates with the **same** schema as prod. This task defines that schema. In Fatia 1 it covers only `model` + `storage?` + `system_prompt?` (no `mcp_servers`, no `tools.rag`, since those are later fatias).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/config/session-schema.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { SessionPayloadSchema } from '../../src/config/session-schema';

test('minimal valid payload (model + user)', () => {
  const payload = {
    user_id: 'demo-user',
    system_prompt: 'You are helpful.',
    model: { provider: 'anthropic', model_id: 'claude-opus-4-7', api_key: 'sk-ant-...' },
  };
  const parsed = SessionPayloadSchema.parse(payload);
  expect(parsed.user_id).toBe('demo-user');
  expect(parsed.model.provider).toBe('anthropic');
});

test('storage.s3 is optional in fatia 1', () => {
  const payload = {
    user_id: 'u',
    model: { provider: 'anthropic', model_id: 'm', api_key: 'k' },
  };
  const parsed = SessionPayloadSchema.parse(payload);
  expect(parsed.storage).toBeUndefined();
});

test('rejects unknown provider', () => {
  const payload = {
    user_id: 'u',
    model: { provider: 'cohere', model_id: 'x', api_key: 'k' },
  };
  expect(() => SessionPayloadSchema.parse(payload)).toThrow();
});

test('rejects empty api_key', () => {
  const payload = {
    user_id: 'u',
    model: { provider: 'anthropic', model_id: 'm', api_key: '' },
  };
  expect(() => SessionPayloadSchema.parse(payload)).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/session-schema.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement schema**

Create `/home/joao/augchatd/src/config/session-schema.ts`:

```typescript
import { z } from 'zod';

const ModelSchema = z.object({
  provider: z.enum(['anthropic']),
  model_id: z.string().min(1),
  api_key: z.string().min(1),
});

const StorageSchema = z.object({
  s3: z.string().min(1),
});

export const SessionPayloadSchema = z.object({
  user_id: z.string().min(1),
  system_prompt: z.string().default('You are a helpful assistant.'),
  model: ModelSchema,
  storage: StorageSchema.optional(),
});

export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/session-schema.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/session-schema.ts tests/config/session-schema.test.ts
git commit -m "feat(config): session payload zod schema (fatia 1 subset)"
```

---

### Task 5: Demo config builder

**Files:**
- Create: `src/config/demo.ts`
- Test: `tests/config/demo.test.ts`

Per Cluster H.3: builds a `SessionPayload` from `DEMO_*` env vars and validates with `SessionPayloadSchema`.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/config/demo.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { buildDemoSession } from '../../src/config/demo';

const baseEnv = {
  DEMO_MODEL_PROVIDER: 'anthropic',
  DEMO_MODEL_ID: 'claude-opus-4-7',
  DEMO_MODEL_API_KEY: 'sk-ant-test',
  DEMO_SYSTEM_PROMPT: 'Be brief.',
};

test('builds valid session from minimal demo env', () => {
  const sess = buildDemoSession(baseEnv);
  expect(sess.user_id).toBe('demo-user');
  expect(sess.system_prompt).toBe('Be brief.');
  expect(sess.model.api_key).toBe('sk-ant-test');
});

test('defaults system prompt when DEMO_SYSTEM_PROMPT missing', () => {
  const env = { ...baseEnv } as Record<string, string>;
  delete env.DEMO_SYSTEM_PROMPT;
  const sess = buildDemoSession(env);
  expect(sess.system_prompt).toMatch(/helpful/i);
});

test('storage.s3 included when DEMO_STORAGE_S3 set', () => {
  const sess = buildDemoSession({ ...baseEnv, DEMO_STORAGE_S3: 's3://bucket/' });
  expect(sess.storage?.s3).toBe('s3://bucket/');
});

test('missing model api key throws', () => {
  const env = { ...baseEnv } as Record<string, string>;
  delete env.DEMO_MODEL_API_KEY;
  expect(() => buildDemoSession(env)).toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/config/demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement builder**

Create `/home/joao/augchatd/src/config/demo.ts`:

```typescript
import { SessionPayloadSchema, type SessionPayload } from './session-schema';

export function buildDemoSession(env: Record<string, string | undefined>): SessionPayload {
  const payload: unknown = {
    user_id: 'demo-user',
    system_prompt: env.DEMO_SYSTEM_PROMPT,
    model: {
      provider: env.DEMO_MODEL_PROVIDER,
      model_id: env.DEMO_MODEL_ID,
      api_key: env.DEMO_MODEL_API_KEY,
    },
    storage: env.DEMO_STORAGE_S3 ? { s3: env.DEMO_STORAGE_S3 } : undefined,
  };
  return SessionPayloadSchema.parse(payload);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/config/demo.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config/demo.ts tests/config/demo.test.ts
git commit -m "feat(config): build demo session payload from env"
```

---

### Task 6: JWT sign/verify with kid routing

**Files:**
- Create: `src/auth/jwt.ts`
- Test: `tests/auth/jwt.test.ts`

Per Cluster B + A.2. HS256, `kid` header routes to `current` or `previous`. `current` signs; both verify.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/auth/jwt.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createJwtModule } from '../../src/auth/jwt';

const k = (s: string) => new TextEncoder().encode(s.padEnd(32, '0'));

test('sign + verify round trip', async () => {
  const mod = createJwtModule({ currentKey: k('A'), ttlSeconds: 60 });
  const jwt = await mod.sign({ sub: 'demo-user', aud: 'urn:tenant:demo', sid: 'sid_x' });
  const claims = await mod.verify(jwt);
  expect(claims.sub).toBe('demo-user');
  expect(claims.aud).toBe('urn:tenant:demo');
  expect(claims.sid).toBe('sid_x');
  expect(typeof claims.exp).toBe('number');
});

test('expired token rejected', async () => {
  const mod = createJwtModule({ currentKey: k('A'), ttlSeconds: -1 }); // already expired
  const jwt = await mod.sign({ sub: 'u', aud: 't', sid: 's' });
  await expect(mod.verify(jwt)).rejects.toThrow();
});

test('token signed with previous key is accepted', async () => {
  const oldMod = createJwtModule({ currentKey: k('OLD'), ttlSeconds: 60 });
  const oldJwt = await oldMod.sign({ sub: 'u', aud: 't', sid: 's' });
  const newMod = createJwtModule({
    currentKey: k('NEW'),
    previousKey: k('OLD'),
    ttlSeconds: 60,
  });
  const claims = await newMod.verify(oldJwt);
  expect(claims.sub).toBe('u');
});

test('token signed with unknown key rejected', async () => {
  const a = createJwtModule({ currentKey: k('A'), ttlSeconds: 60 });
  const jwt = await a.sign({ sub: 'u', aud: 't', sid: 's' });
  const b = createJwtModule({ currentKey: k('B'), ttlSeconds: 60 });
  await expect(b.verify(jwt)).rejects.toThrow();
});

test('signed JWT carries kid=current header', async () => {
  const mod = createJwtModule({ currentKey: k('A'), ttlSeconds: 60 });
  const jwt = await mod.sign({ sub: 'u', aud: 't', sid: 's' });
  const header = JSON.parse(atob(jwt.split('.')[0]!));
  expect(header.kid).toBe('current');
  expect(header.alg).toBe('HS256');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/auth/jwt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement JWT module**

Create `/home/joao/augchatd/src/auth/jwt.ts`:

```typescript
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface JwtConfig {
  currentKey: Uint8Array;
  previousKey?: Uint8Array;
  ttlSeconds: number;
}

export interface AugchatdClaims extends JWTPayload {
  sub: string;
  aud: string;
  sid: string;
}

export interface JwtModule {
  sign(claims: { sub: string; aud: string; sid: string }): Promise<string>;
  verify(token: string): Promise<AugchatdClaims>;
}

export function createJwtModule(cfg: JwtConfig): JwtModule {
  const keys: Record<string, Uint8Array> = { current: cfg.currentKey };
  if (cfg.previousKey) keys.previous = cfg.previousKey;

  return {
    async sign({ sub, aud, sid }) {
      return new SignJWT({ sid })
        .setProtectedHeader({ alg: 'HS256', kid: 'current' })
        .setIssuer('augchatd')
        .setSubject(sub)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + cfg.ttlSeconds)
        .setJti(crypto.randomUUID())
        .sign(cfg.currentKey);
    },
    async verify(token) {
      const header = JSON.parse(
        new TextDecoder().decode(Buffer.from(token.split('.')[0]!, 'base64url')),
      );
      const kid = header.kid as string | undefined;
      const key = kid && keys[kid] ? keys[kid] : undefined;
      if (!key) throw new Error('unknown_kid');
      const { payload } = await jwtVerify(token, key, { issuer: 'augchatd' });
      const sub = payload.sub;
      const aud = typeof payload.aud === 'string' ? payload.aud : undefined;
      const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
      if (!sub || !aud || !sid) throw new Error('malformed_claims');
      return { ...payload, sub, aud, sid };
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/auth/jwt.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/auth/jwt.ts tests/auth/jwt.test.ts
git commit -m "feat(auth): HS256 JWT sign/verify with kid routing"
```

---

### Task 7: In-memory session store

**Files:**
- Create: `src/auth/sessions.ts`
- Test: `tests/auth/sessions.test.ts`

Per Cluster A.4 + D.4. Stores `sid → { tenantId, userId, modelProvider, modelId, modelApiKey, systemPrompt, storage?, stale, expiresAt }`. Get returns undefined if expired or absent. TTL eviction is lazy on get (no background timer needed in fatia 1).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/auth/sessions.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createSessionStore } from '../../src/auth/sessions';

const entry = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'urn:tenant:demo',
  userId: 'demo-user',
  modelProvider: 'anthropic' as const,
  modelId: 'claude-opus-4-7',
  modelApiKey: 'sk-ant-x',
  systemPrompt: 'be helpful',
  expiresAt: Date.now() + 60_000,
  stale: false,
  ...overrides,
});

test('put + get returns same entry', () => {
  const s = createSessionStore();
  s.put('sid_x', entry());
  const got = s.get('sid_x');
  expect(got?.userId).toBe('demo-user');
});

test('get returns undefined for unknown sid', () => {
  const s = createSessionStore();
  expect(s.get('nope')).toBeUndefined();
});

test('get returns undefined for expired entry and evicts', () => {
  const s = createSessionStore();
  s.put('sid_x', entry({ expiresAt: Date.now() - 1000 }));
  expect(s.get('sid_x')).toBeUndefined();
  // Subsequent get also undefined (already evicted)
  expect(s.get('sid_x')).toBeUndefined();
});

test('delete removes immediately', () => {
  const s = createSessionStore();
  s.put('sid_x', entry());
  s.delete('sid_x');
  expect(s.get('sid_x')).toBeUndefined();
});

test('markStale flips flag and entry still retrievable', () => {
  const s = createSessionStore();
  s.put('sid_x', entry());
  s.markStale('sid_x');
  const got = s.get('sid_x');
  expect(got?.stale).toBe(true);
});

test('markStale on missing sid is silent no-op', () => {
  const s = createSessionStore();
  expect(() => s.markStale('nope')).not.toThrow();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/auth/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement store**

Create `/home/joao/augchatd/src/auth/sessions.ts`:

```typescript
export interface SessionEntry {
  tenantId: string;
  userId: string;
  modelProvider: 'anthropic';
  modelId: string;
  modelApiKey: string;
  systemPrompt: string;
  storage?: { s3: string };
  expiresAt: number;
  stale: boolean;
}

export interface SessionStore {
  put(sid: string, entry: SessionEntry): void;
  get(sid: string): SessionEntry | undefined;
  delete(sid: string): void;
  markStale(sid: string): void;
}

export function createSessionStore(): SessionStore {
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
        return undefined;
      }
      return e;
    },
    delete(sid) {
      map.delete(sid);
    },
    markStale(sid) {
      const e = map.get(sid);
      if (e) e.stale = true;
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/auth/sessions.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/auth/sessions.ts tests/auth/sessions.test.ts
git commit -m "feat(auth): in-memory session store with TTL + stale flag"
```

---

### Task 8: Per-tenant SQLite open + schema

**Files:**
- Create: `src/storage/db.ts`
- Test: `tests/storage/db.test.ts`

Per Cluster C.3 + G. Bun's embedded SQLite (`bun:sqlite`). One file per tenant under `hotDir`. WAL mode. Schema applied on open.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/db.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTenantDb, closeAllDbs, dbFilename } from '../../src/storage/db';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('opens a database with schema applied', () => {
  const db = openTenantDb('urn:tenant:demo', hotDir);
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  expect(names).toContain('conversations');
  expect(names).toContain('messages');
  expect(names).toContain('tenant_meta');
});

test('dbFilename is deterministic and avoids unsafe chars', () => {
  const name = dbFilename('urn:augchatd-tenant:acme/corp');
  expect(name).toMatch(/^[a-f0-9]{16}\.sqlite$/);
});

test('openTenantDb returns same instance for same tenant', () => {
  const a = openTenantDb('t1', hotDir);
  const b = openTenantDb('t1', hotDir);
  expect(a).toBe(b);
});

test('tenant_meta records the SAN URI', () => {
  const db = openTenantDb('urn:tenant:demo', hotDir);
  const row = db
    .query("SELECT value FROM tenant_meta WHERE key='tenant_san_uri'")
    .get() as { value: string };
  expect(row.value).toBe('urn:tenant:demo');
});

test('WAL mode is enabled', () => {
  const db = openTenantDb('t1', hotDir);
  const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
  expect(row.journal_mode.toLowerCase()).toBe('wal');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement DB module**

Create `/home/joao/augchatd/src/storage/db.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  title           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  default_model   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  content             TEXT NOT NULL,
  tool_calls          TEXT,
  model_id_used       TEXT,
  created_at          INTEGER NOT NULL,
  flushed_at          INTEGER,
  stopped_by_user     INTEGER NOT NULL DEFAULT 0,
  stopped_by_shutdown INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_flush ON messages(flushed_at);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS tenant_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const dbs = new Map<string, Database>();

export function dbFilename(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 16) + '.sqlite';
}

export function openTenantDb(tenantId: string, hotDir: string): Database {
  const existing = dbs.get(tenantId);
  if (existing) return existing;

  mkdirSync(hotDir, { recursive: true });
  const path = join(hotDir, dbFilename(tenantId));
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.run('INSERT OR IGNORE INTO tenant_meta (key, value) VALUES (?, ?)', [
    'tenant_san_uri',
    tenantId,
  ]);
  db.run('INSERT OR IGNORE INTO tenant_meta (key, value) VALUES (?, ?)', ['schema_version', '1']);
  dbs.set(tenantId, db);
  return db;
}

export function closeAllDbs(): void {
  for (const db of dbs.values()) {
    db.close(false);
  }
  dbs.clear();
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/db.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/db.ts tests/storage/db.test.ts
git commit -m "feat(storage): per-tenant SQLite open with WAL + schema"
```

---

### Task 9: Conversations repository

**Files:**
- Create: `src/storage/conversations.ts`
- Test: `tests/storage/conversations.test.ts`

Per Cluster A.3: implicit create on first message, list by user, delete cascades to messages.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/conversations.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTenantDb, closeAllDbs } from '../../src/storage/db';
import {
  ensureConversation,
  getConversation,
  listConversations,
  deleteConversation,
} from '../../src/storage/conversations';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('ensureConversation creates new', () => {
  const db = openTenantDb('t', hotDir);
  const conv = ensureConversation(db, 'conv-1', 'user-a');
  expect(conv.id).toBe('conv-1');
  expect(conv.userId).toBe('user-a');
});

test('ensureConversation returns existing without overwriting user', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'conv-1', 'user-a');
  const conv = ensureConversation(db, 'conv-1', 'user-a');
  expect(conv.userId).toBe('user-a');
});

test('ensureConversation throws on user mismatch', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'conv-1', 'user-a');
  expect(() => ensureConversation(db, 'conv-1', 'user-b')).toThrow(/forbidden/);
});

test('getConversation returns null when absent', () => {
  const db = openTenantDb('t', hotDir);
  expect(getConversation(db, 'nope')).toBeNull();
});

test('listConversations returns only the user’s conversations', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c-a-1', 'user-a');
  ensureConversation(db, 'c-a-2', 'user-a');
  ensureConversation(db, 'c-b-1', 'user-b');
  const list = listConversations(db, 'user-a');
  expect(list.map((c) => c.id).sort()).toEqual(['c-a-1', 'c-a-2']);
});

test('deleteConversation removes it', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c-1', 'user-a');
  deleteConversation(db, 'c-1', 'user-a');
  expect(getConversation(db, 'c-1')).toBeNull();
});

test('deleteConversation throws on user mismatch', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c-1', 'user-a');
  expect(() => deleteConversation(db, 'c-1', 'user-b')).toThrow(/forbidden/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/conversations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement repo**

Create `/home/joao/augchatd/src/storage/conversations.ts`:

```typescript
import type { Database } from 'bun:sqlite';

export interface Conversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

const rowToConv = (r: Row): Conversation => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getConversation(db: Database, id: string): Conversation | null {
  const row = db
    .query('SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(id) as Row | null;
  return row ? rowToConv(row) : null;
}

export function ensureConversation(db: Database, id: string, userId: string): Conversation {
  const existing = getConversation(db, id);
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error('forbidden');
    }
    return existing;
  }
  const now = Date.now();
  db.run(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    [id, userId, now, now],
  );
  return { id, userId, title: null, createdAt: now, updatedAt: now };
}

export function listConversations(db: Database, userId: string): Conversation[] {
  const rows = db
    .query(
      'SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
    )
    .all(userId) as Row[];
  return rows.map(rowToConv);
}

export function deleteConversation(db: Database, id: string, userId: string): void {
  const existing = getConversation(db, id);
  if (!existing) return;
  if (existing.userId !== userId) {
    throw new Error('forbidden');
  }
  db.run('DELETE FROM conversations WHERE id = ?', [id]);
}

export function touchConversation(db: Database, id: string): void {
  db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [Date.now(), id]);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/conversations.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/conversations.ts tests/storage/conversations.test.ts
git commit -m "feat(storage): conversations repo (ensure/list/delete)"
```

---

### Task 10: Messages repository

**Files:**
- Create: `src/storage/messages.ts`
- Test: `tests/storage/messages.test.ts`

Per Cluster C.3 + A.3. Append, list in order, mark stopped. `flushed_at` column exists but stays NULL in fatia 1 (no flush yet).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/storage/messages.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTenantDb, closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { appendMessage, listMessages, markStoppedByUser } from '../../src/storage/messages';

let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});

afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

test('append + list returns messages in created order', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  appendMessage(db, {
    id: 'm1',
    conversationId: 'c',
    role: 'user',
    content: 'hello',
    createdAt: 1,
  });
  appendMessage(db, {
    id: 'm2',
    conversationId: 'c',
    role: 'assistant',
    content: 'hi',
    createdAt: 2,
    modelIdUsed: 'claude-opus-4-7',
  });
  const list = listMessages(db, 'c');
  expect(list).toHaveLength(2);
  expect(list[0]!.id).toBe('m1');
  expect(list[1]!.modelIdUsed).toBe('claude-opus-4-7');
});

test('markStoppedByUser sets the flag', () => {
  const db = openTenantDb('t', hotDir);
  ensureConversation(db, 'c', 'u');
  appendMessage(db, {
    id: 'm1',
    conversationId: 'c',
    role: 'assistant',
    content: 'partial',
    createdAt: 1,
  });
  markStoppedByUser(db, 'm1');
  const [msg] = listMessages(db, 'c');
  expect(msg!.stoppedByUser).toBe(true);
});

test('list returns empty array for unknown conversation', () => {
  const db = openTenantDb('t', hotDir);
  expect(listMessages(db, 'nope')).toEqual([]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/storage/messages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement repo**

Create `/home/joao/augchatd/src/storage/messages.ts`:

```typescript
import type { Database } from 'bun:sqlite';
import { touchConversation } from './conversations';

export interface NewMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: string;
  modelIdUsed?: string;
  createdAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: string | null;
  modelIdUsed: string | null;
  createdAt: number;
  flushedAt: number | null;
  stoppedByUser: boolean;
  stoppedByShutdown: boolean;
}

interface Row {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: string | null;
  model_id_used: string | null;
  created_at: number;
  flushed_at: number | null;
  stopped_by_user: number;
  stopped_by_shutdown: number;
}

const rowToMsg = (r: Row): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  toolCalls: r.tool_calls,
  modelIdUsed: r.model_id_used,
  createdAt: r.created_at,
  flushedAt: r.flushed_at,
  stoppedByUser: r.stopped_by_user === 1,
  stoppedByShutdown: r.stopped_by_shutdown === 1,
});

export function appendMessage(db: Database, m: NewMessage): void {
  db.run(
    `INSERT INTO messages
       (id, conversation_id, role, content, tool_calls, model_id_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.conversationId,
      m.role,
      m.content,
      m.toolCalls ?? null,
      m.modelIdUsed ?? null,
      m.createdAt,
    ],
  );
  touchConversation(db, m.conversationId);
}

export function listMessages(db: Database, conversationId: string): Message[] {
  const rows = db
    .query(
      `SELECT id, conversation_id, role, content, tool_calls, model_id_used,
              created_at, flushed_at, stopped_by_user, stopped_by_shutdown
         FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId) as Row[];
  return rows.map(rowToMsg);
}

export function markStoppedByUser(db: Database, messageId: string): void {
  db.run('UPDATE messages SET stopped_by_user = 1 WHERE id = ?', [messageId]);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/storage/messages.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/messages.ts tests/storage/messages.test.ts
git commit -m "feat(storage): messages repo (append/list/markStopped)"
```

---

### Task 11: Hono app skeleton with /health and /version

**Files:**
- Create: `src/server/app.ts`, `src/server/routes/health.ts`
- Test: `tests/server/routes/health.test.ts`

Per Cluster I.2: `GET /health` returns 200 with `{ ok: true }`. `GET /version` returns version + git sha (sha unknown at first; placeholder env var `AUGCHATD_VERSION_SHA`).

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/routes/health.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createApp } from '../../../src/server/app';

const appCtx = () => ({
  config: { mode: 'demo' as const, jwt: { ttlSeconds: 600 } },
  // session store, jwt mod not needed for health routes
  versionSha: 'abc123',
  appVersion: '0.0.0',
});

test('GET /health returns 200 with ok', async () => {
  // @ts-expect-error partial ctx for health-only test
  const app = createApp(appCtx());
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test('GET /version returns app version and sha', async () => {
  // @ts-expect-error partial ctx for health-only test
  const app = createApp(appCtx());
  const res = await app.request('/version');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.version).toBe('0.0.0');
  expect(body.sha).toBe('abc123');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/health.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement skeleton + health routes**

Create `/home/joao/augchatd/src/server/routes/health.ts`:

```typescript
import { Hono } from 'hono';
import type { AppCtx } from '../app';

export function healthRoutes(ctx: AppCtx): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/version', (c) => c.json({ version: ctx.appVersion, sha: ctx.versionSha }));
  return app;
}
```

Create `/home/joao/augchatd/src/server/app.ts`:

```typescript
import { Hono } from 'hono';
import type { ProcessConfig } from '../config/env';
import type { SessionStore } from '../auth/sessions';
import type { JwtModule } from '../auth/jwt';
import { healthRoutes } from './routes/health';

export interface AppCtx {
  config: ProcessConfig;
  sessions: SessionStore;
  jwt: JwtModule;
  versionSha: string;
  appVersion: string;
}

export function createApp(ctx: AppCtx): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(ctx));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => c.json({ error: 'internal_error', detail: String(err.message) }, 500));
  return app;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/health.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/routes/health.ts tests/server/routes/health.test.ts
git commit -m "feat(server): Hono app skeleton with /health and /version"
```

---

### Task 12: Demo JWT route

**Files:**
- Create: `src/server/routes/demo.ts`
- Test: `tests/server/routes/demo.test.ts`

Per Cluster H.3. `GET /demo/jwt` mints a fresh JWT for the demo session. Only available when `config.mode === 'demo'`.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/routes/demo.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { createApp } from '../../../src/server/app';
import { createJwtModule } from '../../../src/auth/jwt';
import { createSessionStore } from '../../../src/auth/sessions';

const k = new TextEncoder().encode('A'.repeat(32));

function buildApp(mode: 'demo' | 'prod') {
  const sessions = createSessionStore();
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });
  if (mode === 'demo') {
    sessions.put('demo', {
      tenantId: 'urn:augchatd-tenant:demo',
      userId: 'demo-user',
      modelProvider: 'anthropic',
      modelId: 'claude-opus-4-7',
      modelApiKey: 'sk-ant-x',
      systemPrompt: 'be helpful',
      expiresAt: Date.now() + 24 * 3600 * 1000,
      stale: false,
    });
  }
  return createApp({
    config: { mode, listen: { host: '0', port: 0 }, hotDir: '/tmp', jwt: { currentKey: k, ttlSeconds: 600 } },
    sessions,
    jwt,
    versionSha: 'x',
    appVersion: '0',
  });
}

test('GET /demo/jwt returns a verifiable JWT for the demo session', async () => {
  const app = buildApp('demo');
  const res = await app.request('/demo/jwt');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.jwt).toBe('string');
  expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test('GET /demo/jwt returns 404 in prod mode', async () => {
  const app = buildApp('prod');
  const res = await app.request('/demo/jwt');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement demo route**

Create `/home/joao/augchatd/src/server/routes/demo.ts`:

```typescript
import { Hono } from 'hono';
import type { AppCtx } from '../app';

export const DEMO_SID = 'demo';

export function demoRoutes(ctx: AppCtx): Hono {
  const app = new Hono();
  if (ctx.config.mode !== 'demo') return app;

  app.get('/demo/jwt', async (c) => {
    const entry = ctx.sessions.get(DEMO_SID);
    if (!entry) return c.json({ error: 'demo_session_missing' }, 500);
    const jwt = await ctx.jwt.sign({
      sub: entry.userId,
      aud: entry.tenantId,
      sid: DEMO_SID,
    });
    const expSeconds = Math.floor(Date.now() / 1000) + ctx.config.jwt.ttlSeconds;
    return c.json({ jwt, expires_at: expSeconds });
  });

  return app;
}
```

Modify `/home/joao/augchatd/src/server/app.ts` to mount demo routes. Replace the body of `createApp` with:

```typescript
import { Hono } from 'hono';
import type { ProcessConfig } from '../config/env';
import type { SessionStore } from '../auth/sessions';
import type { JwtModule } from '../auth/jwt';
import { healthRoutes } from './routes/health';
import { demoRoutes } from './routes/demo';

export interface AppCtx {
  config: ProcessConfig;
  sessions: SessionStore;
  jwt: JwtModule;
  versionSha: string;
  appVersion: string;
}

export function createApp(ctx: AppCtx): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(ctx));
  app.route('/', demoRoutes(ctx));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => c.json({ error: 'internal_error', detail: String(err.message) }, 500));
  return app;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/demo.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all passing (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/routes/demo.ts tests/server/routes/demo.test.ts
git commit -m "feat(server): GET /demo/jwt mints JWT for demo session"
```

---

### Task 13: JWT auth middleware

**Files:**
- Create: `src/server/middleware/jwt-auth.ts`
- Test: `tests/server/middleware/jwt-auth.test.ts`

Per Cluster A.4 + D.4. Parses `Authorization: Bearer <jwt>`; verifies; looks up session by `sid`; rejects if stale; attaches session to context.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/middleware/jwt-auth.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { createJwtModule } from '../../../src/auth/jwt';
import { createSessionStore, type SessionEntry } from '../../../src/auth/sessions';
import { jwtAuth } from '../../../src/server/middleware/jwt-auth';

const k = new TextEncoder().encode('A'.repeat(32));
const baseEntry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
  tenantId: 'urn:t:demo',
  userId: 'demo-user',
  modelProvider: 'anthropic',
  modelId: 'claude-opus-4-7',
  modelApiKey: 'k',
  systemPrompt: 'p',
  expiresAt: Date.now() + 60_000,
  stale: false,
  ...over,
});

function build(seedSid: string | null, entry?: SessionEntry) {
  const sessions = createSessionStore();
  if (seedSid && entry) sessions.put(seedSid, entry);
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });
  const app = new Hono();
  app.use('*', jwtAuth({ jwt, sessions }));
  app.get('/echo', (c) => c.json({ userId: c.get('session').userId }));
  return { app, jwt };
}

test('rejects missing Authorization', async () => {
  const { app } = build(null);
  const res = await app.request('/echo');
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('auth_required');
});

test('rejects malformed Authorization', async () => {
  const { app } = build(null);
  const res = await app.request('/echo', { headers: { Authorization: 'Token abc' } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('auth_required');
});

test('rejects bad signature', async () => {
  const { app } = build(null);
  const res = await app.request('/echo', { headers: { Authorization: 'Bearer not.a.jwt' } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('auth_invalid');
});

test('rejects unknown sid', async () => {
  const { app, jwt } = build(null);
  const token = await jwt.sign({ sub: 'u', aud: 't', sid: 'unknown' });
  const res = await app.request('/echo', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('session_not_found');
});

test('rejects stale session with mcp_credentials_expired code', async () => {
  const { app, jwt } = build('sid_x', baseEntry({ stale: true }));
  const token = await jwt.sign({ sub: 'demo-user', aud: 'urn:t:demo', sid: 'sid_x' });
  const res = await app.request('/echo', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('mcp_credentials_expired');
});

test('passes and attaches session for valid request', async () => {
  const { app, jwt } = build('sid_x', baseEntry());
  const token = await jwt.sign({ sub: 'demo-user', aud: 'urn:t:demo', sid: 'sid_x' });
  const res = await app.request('/echo', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect((await res.json()).userId).toBe('demo-user');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/middleware/jwt-auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement middleware**

Create `/home/joao/augchatd/src/server/middleware/jwt-auth.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import type { JwtModule } from '../../auth/jwt';
import type { SessionEntry, SessionStore } from '../../auth/sessions';

export interface JwtAuthDeps {
  jwt: JwtModule;
  sessions: SessionStore;
}

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionEntry;
    sid: string;
  }
}

export function jwtAuth(deps: JwtAuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'auth_required' }, 401);
    }
    const token = header.slice('Bearer '.length).trim();
    let sid: string;
    try {
      const claims = await deps.jwt.verify(token);
      sid = claims.sid;
    } catch {
      return c.json({ error: 'auth_invalid' }, 401);
    }
    const session = deps.sessions.get(sid);
    if (!session) {
      return c.json({ error: 'session_not_found' }, 401);
    }
    if (session.stale) {
      return c.json({ error: 'mcp_credentials_expired' }, 401);
    }
    c.set('session', session);
    c.set('sid', sid);
    await next();
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/middleware/jwt-auth.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/jwt-auth.ts tests/server/middleware/jwt-auth.test.ts
git commit -m "feat(server): JWT auth middleware with stale rejection"
```

---

### Task 14: Conversations API (GET list, DELETE)

**Files:**
- Create: `src/server/routes/conversations.ts`
- Test: `tests/server/routes/conversations.test.ts`

Per Cluster A.3. Both routes are JWT-authed. List returns the user's conversations only.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/routes/conversations.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../src/server/app';
import { createJwtModule } from '../../../src/auth/jwt';
import { createSessionStore } from '../../../src/auth/sessions';
import { openTenantDb, closeAllDbs } from '../../../src/storage/db';
import { ensureConversation } from '../../../src/storage/conversations';

const k = new TextEncoder().encode('A'.repeat(32));
let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});
afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

async function build() {
  const sessions = createSessionStore();
  sessions.put('demo', {
    tenantId: 'urn:t:demo',
    userId: 'demo-user',
    modelProvider: 'anthropic',
    modelId: 'm',
    modelApiKey: 'k',
    systemPrompt: 'p',
    expiresAt: Date.now() + 60_000,
    stale: false,
  });
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });
  const app = createApp({
    config: { mode: 'demo', listen: { host: '0', port: 0 }, hotDir, jwt: { currentKey: k, ttlSeconds: 600 } },
    sessions,
    jwt,
    versionSha: 'x',
    appVersion: '0',
  });
  const token = await jwt.sign({ sub: 'demo-user', aud: 'urn:t:demo', sid: 'demo' });
  return { app, token };
}

test('GET /conversations returns user conversations', async () => {
  const { app, token } = await build();
  const db = openTenantDb('urn:t:demo', hotDir);
  ensureConversation(db, 'c-1', 'demo-user');
  ensureConversation(db, 'c-2', 'demo-user');
  ensureConversation(db, 'c-other', 'other-user');

  const res = await app.request('/conversations', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.conversations.map((c: { id: string }) => c.id).sort()).toEqual(['c-1', 'c-2']);
});

test('DELETE /conversations/{id} removes it', async () => {
  const { app, token } = await build();
  const db = openTenantDb('urn:t:demo', hotDir);
  ensureConversation(db, 'c-1', 'demo-user');

  const res = await app.request('/conversations/c-1', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(204);
  const list = await (
    await app.request('/conversations', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(list.conversations).toEqual([]);
});

test('GET /conversations without auth → 401', async () => {
  const { app } = await build();
  const res = await app.request('/conversations');
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/conversations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement routes**

Create `/home/joao/augchatd/src/server/routes/conversations.ts`:

```typescript
import { Hono } from 'hono';
import type { AppCtx } from '../app';
import { jwtAuth } from '../middleware/jwt-auth';
import { openTenantDb } from '../../storage/db';
import { listConversations, deleteConversation } from '../../storage/conversations';

export function conversationsRoutes(ctx: AppCtx): Hono {
  const app = new Hono();
  app.use('*', jwtAuth({ jwt: ctx.jwt, sessions: ctx.sessions }));

  app.get('/conversations', (c) => {
    const session = c.get('session');
    const db = openTenantDb(session.tenantId, ctx.config.hotDir);
    const conversations = listConversations(db, session.userId);
    return c.json({ conversations });
  });

  app.delete('/conversations/:id', (c) => {
    const session = c.get('session');
    const db = openTenantDb(session.tenantId, ctx.config.hotDir);
    try {
      deleteConversation(db, c.req.param('id'), session.userId);
    } catch (e) {
      if ((e as Error).message === 'forbidden') {
        return c.json({ error: 'forbidden' }, 403);
      }
      throw e;
    }
    return c.body(null, 204);
  });

  return app;
}
```

Modify `/home/joao/augchatd/src/server/app.ts` — add the route mount inside `createApp`, immediately after `demoRoutes`:

```typescript
import { conversationsRoutes } from './routes/conversations';
// ... inside createApp, after the demoRoutes line:
app.route('/', conversationsRoutes(ctx));
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/conversations.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/routes/conversations.ts tests/server/routes/conversations.test.ts
git commit -m "feat(server): GET /conversations and DELETE /conversations/{id}"
```

---

### Task 15: Chat streaming module (Vercel AI SDK plumbing)

**Files:**
- Create: `src/chat/stream.ts`
- Test: `tests/chat/stream.test.ts`

Per Cluster D. This module takes a session, conversation, and a new user message, persists it, runs `streamText` against the right provider, and returns a Response that speaks the Vercel AI SDK data stream protocol. On finish it persists the assistant message. Cancellation via `AbortSignal` from the HTTP request.

Testing strategy: inject a mock model that emits a known stream; assert the persisted assistant message + the response Content-Type.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/chat/stream.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV1 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { runChat } from '../../src/chat/stream';
import { openTenantDb, closeAllDbs } from '../../src/storage/db';
import { ensureConversation } from '../../src/storage/conversations';
import { listMessages } from '../../src/storage/messages';

let hotDir: string;
beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});
afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

const session = {
  tenantId: 'urn:t:demo',
  userId: 'demo-user',
  modelProvider: 'anthropic' as const,
  modelId: 'm',
  modelApiKey: 'k',
  systemPrompt: 'be brief',
  expiresAt: Date.now() + 60_000,
  stale: false,
};

function makeMockModel() {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: 'Hello' },
          { type: 'text-delta', textDelta: ' there' },
          {
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: { promptTokens: 1, completionTokens: 2 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

test('runChat persists user and assistant messages, returns data-stream Response', async () => {
  const db = openTenantDb(session.tenantId, hotDir);
  ensureConversation(db, 'conv-1', session.userId);

  const res = await runChat({
    session,
    conversationId: 'conv-1',
    userMessage: 'hi',
    hotDir,
    abortSignal: new AbortController().signal,
    modelOverride: makeMockModel(),
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/plain');
  // Drain so onFinish runs
  await res.text();

  const msgs = listMessages(db, 'conv-1');
  expect(msgs).toHaveLength(2);
  expect(msgs[0]!.role).toBe('user');
  expect(msgs[0]!.content).toBe('hi');
  expect(msgs[1]!.role).toBe('assistant');
  expect(msgs[1]!.content).toBe('Hello there');
  expect(msgs[1]!.modelIdUsed).toBe('m');
});

test('runChat creates conversation implicitly if missing', async () => {
  const db = openTenantDb(session.tenantId, hotDir);
  const res = await runChat({
    session,
    conversationId: 'conv-new',
    userMessage: 'hi',
    hotDir,
    abortSignal: new AbortController().signal,
    modelOverride: makeMockModel(),
  });
  await res.text();
  expect(listMessages(db, 'conv-new')).toHaveLength(2);
});

test('runChat rejects when conversation belongs to another user', async () => {
  const db = openTenantDb(session.tenantId, hotDir);
  ensureConversation(db, 'conv-other', 'other-user');
  await expect(
    runChat({
      session,
      conversationId: 'conv-other',
      userMessage: 'hi',
      hotDir,
      abortSignal: new AbortController().signal,
      modelOverride: makeMockModel(),
    }),
  ).rejects.toThrow(/forbidden/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/chat/stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement chat module**

Create `/home/joao/augchatd/src/chat/stream.ts`:

```typescript
import { streamText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { SessionEntry } from '../auth/sessions';
import { openTenantDb } from '../storage/db';
import { ensureConversation } from '../storage/conversations';
import { appendMessage, listMessages } from '../storage/messages';

export interface RunChatInput {
  session: SessionEntry;
  conversationId: string;
  userMessage: string;
  hotDir: string;
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

export async function runChat(input: RunChatInput): Promise<Response> {
  const db = openTenantDb(input.session.tenantId, input.hotDir);
  ensureConversation(db, input.conversationId, input.session.userId);

  const userMsgId = crypto.randomUUID();
  appendMessage(db, {
    id: userMsgId,
    conversationId: input.conversationId,
    role: 'user',
    content: input.userMessage,
    createdAt: Date.now(),
  });

  const history = listMessages(db, input.conversationId).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const model = resolveModel(input.session, input.modelOverride);
  const result = await streamText({
    model,
    system: input.session.systemPrompt,
    messages: history,
    abortSignal: input.abortSignal,
    onFinish: async ({ text }) => {
      appendMessage(db, {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        modelIdUsed: input.session.modelId,
      });
    },
  });

  return result.toDataStreamResponse();
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/chat/stream.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/chat/stream.ts tests/chat/stream.test.ts
git commit -m "feat(chat): runChat persists messages and streams via Vercel AI SDK"
```

---

### Task 16: Messages route (POST /conversations/{id}/messages)

**Files:**
- Create: `src/server/routes/messages.ts`
- Test: `tests/server/routes/messages.test.ts`

Wires the chat module behind the JWT-authed route.

- [ ] **Step 1: Write failing tests**

Create `/home/joao/augchatd/tests/server/routes/messages.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV1 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { createApp } from '../../../src/server/app';
import { createJwtModule } from '../../../src/auth/jwt';
import { createSessionStore } from '../../../src/auth/sessions';
import { closeAllDbs } from '../../../src/storage/db';

const k = new TextEncoder().encode('A'.repeat(32));
let hotDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-test-'));
});
afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
});

function mockModel() {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: 'pong' },
          {
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

async function build() {
  const sessions = createSessionStore();
  sessions.put('demo', {
    tenantId: 'urn:t:demo',
    userId: 'demo-user',
    modelProvider: 'anthropic',
    modelId: 'm',
    modelApiKey: 'k',
    systemPrompt: 'p',
    expiresAt: Date.now() + 60_000,
    stale: false,
  });
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });
  const app = createApp({
    config: { mode: 'demo', listen: { host: '0', port: 0 }, hotDir, jwt: { currentKey: k, ttlSeconds: 600 } },
    sessions,
    jwt,
    versionSha: 'x',
    appVersion: '0',
    modelOverride: mockModel(),
  });
  const token = await jwt.sign({ sub: 'demo-user', aud: 'urn:t:demo', sid: 'demo' });
  return { app, token };
}

test('POST /conversations/{id}/messages streams pong', async () => {
  const { app, token } = await build();
  const res = await app.request('/conversations/conv-1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'ping' }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('pong');
});

test('POST without auth → 401', async () => {
  const { app } = await build();
  const res = await app.request('/conversations/conv-1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'ping' }),
  });
  expect(res.status).toBe(401);
});

test('POST with malformed body → 400', async () => {
  const { app, token } = await build();
  const res = await app.request('/conversations/conv-1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/messages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

Modify `/home/joao/augchatd/src/server/app.ts` to accept an optional `modelOverride` for tests. Replace `AppCtx` interface and the `createApp` import section:

```typescript
import { Hono } from 'hono';
import type { LanguageModel } from 'ai';
import type { ProcessConfig } from '../config/env';
import type { SessionStore } from '../auth/sessions';
import type { JwtModule } from '../auth/jwt';
import { healthRoutes } from './routes/health';
import { demoRoutes } from './routes/demo';
import { conversationsRoutes } from './routes/conversations';
import { messagesRoutes } from './routes/messages';

export interface AppCtx {
  config: ProcessConfig;
  sessions: SessionStore;
  jwt: JwtModule;
  versionSha: string;
  appVersion: string;
  modelOverride?: LanguageModel;
}

export function createApp(ctx: AppCtx): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(ctx));
  app.route('/', demoRoutes(ctx));
  app.route('/', conversationsRoutes(ctx));
  app.route('/', messagesRoutes(ctx));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => c.json({ error: 'internal_error', detail: String(err.message) }, 500));
  return app;
}
```

Create `/home/joao/augchatd/src/server/routes/messages.ts`:

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppCtx } from '../app';
import { jwtAuth } from '../middleware/jwt-auth';
import { runChat } from '../../chat/stream';

const BodySchema = z.object({ message: z.string().min(1) });

export function messagesRoutes(ctx: AppCtx): Hono {
  const app = new Hono();
  app.use('*', jwtAuth({ jwt: ctx.jwt, sessions: ctx.sessions }));

  app.post('/conversations/:id/messages', async (c) => {
    const session = c.get('session');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', detail: 'invalid_json' }, 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'bad_request', detail: parsed.error.format() }, 400);
    }
    try {
      return await runChat({
        session,
        conversationId: c.req.param('id'),
        userMessage: parsed.data.message,
        hotDir: ctx.config.hotDir,
        abortSignal: c.req.raw.signal,
        modelOverride: ctx.modelOverride,
      });
    } catch (e) {
      if ((e as Error).message === 'forbidden') {
        return c.json({ error: 'forbidden' }, 403);
      }
      throw e;
    }
  });

  return app;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/messages.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/routes/messages.ts tests/server/routes/messages.test.ts
git commit -m "feat(server): POST /conversations/{id}/messages streaming"
```

---

### Task 17: UI bootstrap (Vite + React + assistant-ui)

**Files:**
- Create: `ui/package.json`, `ui/tsconfig.json`, `ui/vite.config.ts`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/App.tsx`

UI is a standalone Vite project that builds to `ui/dist/`. Backend later serves these files.

- [ ] **Step 1: Create ui/package.json**

Create `/home/joao/augchatd/ui/package.json`:

```json
{
  "name": "augchatd-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@assistant-ui/react": "^0.7.0",
    "@assistant-ui/react-ai-sdk": "^0.7.0",
    "ai": "^4.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create ui/tsconfig.json**

Create `/home/joao/augchatd/ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create ui/vite.config.ts**

Create `/home/joao/augchatd/ui/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/conversations': 'http://localhost:8080',
      '/demo': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
    },
  },
});
```

- [ ] **Step 4: Create ui/index.html**

Create `/home/joao/augchatd/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>augchatd</title>
    <style>
      html, body, #root { height: 100%; margin: 0; font-family: system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create ui/src/main.tsx (placeholder app)**

Create `/home/joao/augchatd/ui/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root_missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `/home/joao/augchatd/ui/src/App.tsx`:

```tsx
export function App() {
  return <div>augchatd UI booting…</div>;
}
```

- [ ] **Step 6: Install UI deps and verify build**

Run: `cd ui && bun install && bun run build && cd ..`
Expected: `ui/dist/index.html` and assets are generated; no TS errors.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/tsconfig.json ui/vite.config.ts ui/index.html ui/src/main.tsx ui/src/App.tsx ui/bun.lockb
git commit -m "feat(ui): Vite + React + assistant-ui bootstrap"
```

---

### Task 18: UI parent ↔ iframe postMessage protocol

**Files:**
- Create: `ui/src/parent.ts`
- Test: `ui/src/parent.test.ts`

Per Cluster F. Five-message protocol. `parent_origin` from URL query string for origin validation.

- [ ] **Step 1: Add a test runner to UI for this unit**

Modify `/home/joao/augchatd/ui/package.json` — add `"test": "bun test"` to scripts and `"@types/bun": "latest"` to devDependencies. Run `bun install` in `ui/`.

- [ ] **Step 2: Write failing test**

Create `/home/joao/augchatd/ui/src/parent.test.ts`:

```typescript
import { test, expect, mock } from 'bun:test';
import { createParentBridge } from './parent';

function fakeWindow() {
  const listeners: Array<(ev: MessageEvent) => void> = [];
  return {
    listeners,
    addEventListener: (type: string, cb: (ev: MessageEvent) => void) => {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener: (type: string, cb: (ev: MessageEvent) => void) => {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    },
    parent: {
      postMessages: [] as Array<{ data: unknown; origin: string }>,
      postMessage(data: unknown, origin: string) {
        this.postMessages.push({ data, origin });
      },
    },
  };
}

test('emit(ready) posts to parent_origin', () => {
  const w = fakeWindow();
  const bridge = createParentBridge({
    win: w as never,
    parentOrigin: 'https://app.example.com',
  });
  bridge.emit({ type: 'augchatd:ready' });
  expect(w.parent.postMessages).toEqual([
    { data: { type: 'augchatd:ready' }, origin: 'https://app.example.com' },
  ]);
});

test('onMessage rejects events from wrong origin', () => {
  const w = fakeWindow();
  const seen: unknown[] = [];
  createParentBridge({
    win: w as never,
    parentOrigin: 'https://app.example.com',
    onMessage: (m) => seen.push(m),
  });
  // Wrong origin
  w.listeners[0]!({ data: { type: 'augchatd:jwt', jwt: 'x' }, origin: 'https://evil.com' } as MessageEvent);
  expect(seen).toEqual([]);

  // Correct origin
  w.listeners[0]!({
    data: { type: 'augchatd:jwt', jwt: 'y' },
    origin: 'https://app.example.com',
  } as MessageEvent);
  expect(seen).toEqual([{ type: 'augchatd:jwt', jwt: 'y' }]);
});

test('emit(auth-required) and emit(resize) shape', () => {
  const w = fakeWindow();
  const bridge = createParentBridge({ win: w as never, parentOrigin: 'https://x' });
  bridge.emit({ type: 'augchatd:auth-required', reason: 'jwt_expired' });
  bridge.emit({ type: 'augchatd:resize', height: 600 });
  expect(w.parent.postMessages.map((p) => p.data)).toEqual([
    { type: 'augchatd:auth-required', reason: 'jwt_expired' },
    { type: 'augchatd:resize', height: 600 },
  ]);
});

test('parseParentOrigin extracts from URL search', () => {
  const { parseParentOrigin } = require('./parent');
  expect(
    parseParentOrigin('https://augchatd/?parent_origin=https%3A%2F%2Fapp.example.com'),
  ).toBe('https://app.example.com');
  expect(parseParentOrigin('https://augchatd/')).toBeNull();
});
```

- [ ] **Step 3: Run, verify failure**

Run: `cd ui && bun test src/parent.test.ts && cd ..`
Expected: FAIL.

- [ ] **Step 4: Implement bridge**

Create `/home/joao/augchatd/ui/src/parent.ts`:

```typescript
export type OutMessage =
  | { type: 'augchatd:ready' }
  | { type: 'augchatd:auth-required'; reason: AuthRequiredReason }
  | { type: 'augchatd:resize'; height: number }
  | { type: 'augchatd:fatal'; code: string; message: string };

export type AuthRequiredReason =
  | 'jwt_expired'
  | 'jwt_invalid'
  | 'mcp_credentials_expired'
  | 'session_revoked';

export type InMessage = { type: 'augchatd:jwt'; jwt: string };

export interface BridgeOptions {
  win: Window;
  parentOrigin: string;
  onMessage?: (msg: InMessage) => void;
}

export interface Bridge {
  emit(msg: OutMessage): void;
  dispose(): void;
}

export function parseParentOrigin(href: string): string | null {
  const url = new URL(href);
  const po = url.searchParams.get('parent_origin');
  return po ?? null;
}

export function createParentBridge(opts: BridgeOptions): Bridge {
  const handler = (ev: MessageEvent) => {
    if (ev.origin !== opts.parentOrigin) return;
    const data = ev.data as InMessage | undefined;
    if (!data || typeof data !== 'object' || data.type !== 'augchatd:jwt') return;
    if (typeof data.jwt !== 'string') return;
    opts.onMessage?.(data);
  };
  opts.win.addEventListener('message', handler);
  return {
    emit(msg) {
      opts.win.parent.postMessage(msg, opts.parentOrigin);
    },
    dispose() {
      opts.win.removeEventListener('message', handler);
    },
  };
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd ui && bun test src/parent.test.ts && cd ..`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add ui/package.json ui/src/parent.ts ui/src/parent.test.ts ui/bun.lockb
git commit -m "feat(ui): postMessage bridge with origin validation"
```

---

### Task 19: UI runtime adapter and App wiring

**Files:**
- Modify: `ui/src/App.tsx`
- Create: `ui/src/runtime.ts`

Per Cluster F + D. App boots, parses `parent_origin`, emits `augchatd:ready`, awaits `augchatd:jwt`, mounts assistant-ui Thread with a runtime that calls `POST /conversations/{convId}/messages` with the JWT. On 401, emits `augchatd:auth-required` and waits for a new JWT.

- [ ] **Step 1: Implement runtime adapter**

Create `/home/joao/augchatd/ui/src/runtime.ts`:

```typescript
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { AuthRequiredReason } from './parent';

export interface UseAugchatdRuntimeOptions {
  conversationId: string;
  jwt: string | null;
  onAuthRequired: (reason: AuthRequiredReason) => void;
}

export function useAugchatdRuntime(opts: UseAugchatdRuntimeOptions) {
  return useChatRuntime({
    api: `/conversations/${opts.conversationId}/messages`,
    headers: () => (opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    body: ({ messages }) => {
      const last = messages[messages.length - 1];
      return { message: typeof last?.content === 'string' ? last.content : '' };
    },
    onError: (err) => {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        const body = (err as { body?: { error?: string } }).body;
        const reason: AuthRequiredReason =
          body?.error === 'mcp_credentials_expired'
            ? 'mcp_credentials_expired'
            : body?.error === 'session_not_found'
              ? 'session_revoked'
              : body?.error === 'auth_invalid'
                ? 'jwt_invalid'
                : 'jwt_expired';
        opts.onAuthRequired(reason);
      }
    },
  });
}
```

- [ ] **Step 2: Implement App.tsx**

Replace `/home/joao/augchatd/ui/src/App.tsx` content:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { Thread } from '@assistant-ui/react';
import {
  createParentBridge,
  parseParentOrigin,
  type AuthRequiredReason,
  type Bridge,
} from './parent';
import { useAugchatdRuntime } from './runtime';

export function App() {
  const [jwt, setJwt] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const convId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    const parentOrigin = parseParentOrigin(window.location.href);
    if (!parentOrigin) {
      // Standalone (no parent embedding) — fetch demo JWT directly.
      fetch('/demo/jwt')
        .then((r) => {
          if (!r.ok) throw new Error('demo_jwt_unavailable');
          return r.json();
        })
        .then((j: { jwt: string }) => setJwt(j.jwt))
        .catch(() => setFatal('no_parent_origin_and_no_demo_jwt'));
      return;
    }
    const bridge = createParentBridge({
      win: window,
      parentOrigin,
      onMessage: (msg) => {
        if (msg.type === 'augchatd:jwt') setJwt(msg.jwt);
      },
    });
    bridgeRef.current = bridge;
    bridge.emit({ type: 'augchatd:ready' });

    const ro = new ResizeObserver(() => {
      bridge.emit({ type: 'augchatd:resize', height: document.documentElement.scrollHeight });
    });
    ro.observe(document.documentElement);

    return () => {
      ro.disconnect();
      bridge.dispose();
    };
  }, []);

  const onAuthRequired = (reason: AuthRequiredReason) => {
    setJwt(null);
    bridgeRef.current?.emit({ type: 'augchatd:auth-required', reason });
  };

  const runtime = useAugchatdRuntime({ conversationId: convId, jwt, onAuthRequired });

  if (fatal) return <pre>FATAL: {fatal}</pre>;
  if (!jwt) return <div>Waiting for credentials…</div>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div style={{ height: '100vh' }}>
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 3: Build to verify**

Run: `cd ui && bun run build && cd ..`
Expected: build succeeds; `ui/dist/index.html` present.

- [ ] **Step 4: Commit**

```bash
git add ui/src/runtime.ts ui/src/App.tsx
git commit -m "feat(ui): assistant-ui Thread + JWT-aware runtime + parent bridge wiring"
```

---

### Task 20: UI conversation sidebar (list + new + delete + retomada via localStorage)

**Files:**
- Create: `ui/src/conversations-client.ts`
- Create: `ui/src/Sidebar.tsx`
- Test: `ui/src/conversations-client.test.ts`
- Modify: `ui/src/App.tsx`, `ui/src/runtime.ts`

Per Spec §7. The single-conversation `App.tsx` from Task 19 can't satisfy "reload preserves the conversation" or "delete via UI". This task adds: (a) an API client for `/conversations` + `DELETE /conversations/{id}`, (b) a `Sidebar` component that lists conversations and supports new/delete, (c) `localStorage` persistence of the active conversation id, (d) wiring in `App.tsx` so reload resumes the same conversation and the sidebar can switch between them.

- [ ] **Step 1: Write failing tests for the client + localStorage helper**

Create `/home/joao/augchatd/ui/src/conversations-client.test.ts`:

```typescript
import { test, expect, beforeEach } from 'bun:test';
import { loadActiveConvId, setActiveConvId } from './conversations-client';

const KEY = 'augchatd:activeConvId';

beforeEach(() => {
  // jsdom-free env: bun:test provides a localStorage shim via Bun
  globalThis.localStorage?.clear?.();
});

test('loadActiveConvId returns stored id when present', () => {
  globalThis.localStorage.setItem(KEY, 'conv-xyz');
  expect(loadActiveConvId()).toBe('conv-xyz');
});

test('loadActiveConvId mints a fresh UUID when absent and persists it', () => {
  expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  const id = loadActiveConvId();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(globalThis.localStorage.getItem(KEY)).toBe(id);
});

test('setActiveConvId persists', () => {
  setActiveConvId('conv-abc');
  expect(globalThis.localStorage.getItem(KEY)).toBe('conv-abc');
});
```

If `localStorage` is not available under `bun test` for this UI directory, gate the tests with `test.if(typeof localStorage !== 'undefined')` — the helpers themselves must work with or without the storage (degrade to in-memory).

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && bun test src/conversations-client.test.ts && cd ..`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the API client + localStorage helper**

Create `/home/joao/augchatd/ui/src/conversations-client.ts`:

```typescript
const STORAGE_KEY = 'augchatd:activeConvId';

const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null =
  typeof localStorage !== 'undefined' ? localStorage : null;

export interface ConversationSummary {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export function loadActiveConvId(): string {
  const stored = storage?.getItem(STORAGE_KEY);
  if (stored) return stored;
  const fresh = crypto.randomUUID();
  storage?.setItem(STORAGE_KEY, fresh);
  return fresh;
}

export function setActiveConvId(id: string): void {
  storage?.setItem(STORAGE_KEY, id);
}

export async function listConversations(jwt: string): Promise<ConversationSummary[]> {
  const res = await fetch('/conversations', {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

export async function deleteConversation(jwt: string, id: string): Promise<boolean> {
  const res = await fetch(`/conversations/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return res.ok;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ui && bun test src/conversations-client.test.ts && cd ..`
Expected: 3 passing.

- [ ] **Step 5: Implement Sidebar component**

Create `/home/joao/augchatd/ui/src/Sidebar.tsx`:

```tsx
import { useEffect, useState } from 'react';
import {
  type ConversationSummary,
  listConversations,
  deleteConversation,
} from './conversations-client';

export interface SidebarProps {
  jwt: string;
  activeId: string;
  refreshKey: number;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function Sidebar({ jwt, activeId, refreshKey, onSelect, onNew }: SidebarProps) {
  const [items, setItems] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    listConversations(jwt).then((list) => {
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
  }, [jwt, refreshKey, activeId]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await deleteConversation(jwt, id);
    if (!ok) return;
    setItems((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) onNew();
  };

  return (
    <aside
      style={{
        width: 240,
        borderRight: '1px solid #ddd',
        padding: 12,
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <button
        onClick={onNew}
        style={{ width: '100%', padding: 8, marginBottom: 12, cursor: 'pointer' }}
      >
        + New conversation
      </button>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((c) => (
          <li
            key={c.id}
            onClick={() => onSelect(c.id)}
            style={{
              padding: 8,
              cursor: 'pointer',
              background: c.id === activeId ? '#eef' : 'transparent',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 4,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {c.title ?? c.id.slice(0, 8)}
            </span>
            <button
              onClick={(e) => handleDelete(c.id, e)}
              aria-label="Delete conversation"
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 16,
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 6: Extend the runtime adapter with an onFinish callback**

Modify `/home/joao/augchatd/ui/src/runtime.ts` to forward `onFinish` from `useChatRuntime` so `App.tsx` can bump the sidebar refresh key after each successful turn:

```typescript
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { AuthRequiredReason } from './parent';

export interface UseAugchatdRuntimeOptions {
  conversationId: string;
  jwt: string | null;
  onAuthRequired: (reason: AuthRequiredReason) => void;
  onFinish?: () => void;
}

export function useAugchatdRuntime(opts: UseAugchatdRuntimeOptions) {
  return useChatRuntime({
    api: `/conversations/${opts.conversationId}/messages`,
    headers: () => (opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    body: ({ messages }) => {
      const last = messages[messages.length - 1];
      return { message: typeof last?.content === 'string' ? last.content : '' };
    },
    onFinish: () => opts.onFinish?.(),
    onError: (err) => {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        const body = (err as { body?: { error?: string } }).body;
        const reason: AuthRequiredReason =
          body?.error === 'mcp_credentials_expired'
            ? 'mcp_credentials_expired'
            : body?.error === 'session_not_found'
              ? 'session_revoked'
              : body?.error === 'auth_invalid'
                ? 'jwt_invalid'
                : 'jwt_expired';
        opts.onAuthRequired(reason);
      }
    },
  });
}
```

- [ ] **Step 7: Rewrite App.tsx to wire Sidebar + active conv + retomada**

Replace `/home/joao/augchatd/ui/src/App.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, Thread } from '@assistant-ui/react';
import {
  createParentBridge,
  parseParentOrigin,
  type AuthRequiredReason,
  type Bridge,
} from './parent';
import { useAugchatdRuntime } from './runtime';
import { Sidebar } from './Sidebar';
import { loadActiveConvId, setActiveConvId } from './conversations-client';

export function App() {
  const [jwt, setJwt] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [activeConvId, setActiveConv] = useState<string>(() => loadActiveConvId());
  const [refreshKey, setRefreshKey] = useState(0);
  const bridgeRef = useRef<Bridge | null>(null);

  useEffect(() => {
    setActiveConvId(activeConvId);
  }, [activeConvId]);

  useEffect(() => {
    const parentOrigin = parseParentOrigin(window.location.href);
    if (!parentOrigin) {
      fetch('/demo/jwt')
        .then((r) => {
          if (!r.ok) throw new Error('demo_jwt_unavailable');
          return r.json();
        })
        .then((j: { jwt: string }) => setJwt(j.jwt))
        .catch(() => setFatal('no_parent_origin_and_no_demo_jwt'));
      return;
    }
    const bridge = createParentBridge({
      win: window,
      parentOrigin,
      onMessage: (msg) => {
        if (msg.type === 'augchatd:jwt') setJwt(msg.jwt);
      },
    });
    bridgeRef.current = bridge;
    bridge.emit({ type: 'augchatd:ready' });

    const ro = new ResizeObserver(() => {
      bridge.emit({ type: 'augchatd:resize', height: document.documentElement.scrollHeight });
    });
    ro.observe(document.documentElement);

    return () => {
      ro.disconnect();
      bridge.dispose();
    };
  }, []);

  const onAuthRequired = (reason: AuthRequiredReason) => {
    setJwt(null);
    bridgeRef.current?.emit({ type: 'augchatd:auth-required', reason });
  };

  const handleNewConversation = () => setActiveConv(crypto.randomUUID());
  const handleSelect = (id: string) => setActiveConv(id);

  const runtime = useAugchatdRuntime({
    conversationId: activeConvId,
    jwt,
    onAuthRequired,
    onFinish: () => setRefreshKey((k) => k + 1),
  });

  if (fatal) return <pre>FATAL: {fatal}</pre>;
  if (!jwt) return <div>Waiting for credentials…</div>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div style={{ display: 'flex', height: '100vh' }}>
        <Sidebar
          jwt={jwt}
          activeId={activeConvId}
          refreshKey={refreshKey}
          onSelect={handleSelect}
          onNew={handleNewConversation}
        />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 8: Build to verify**

Run: `cd ui && bun run build && cd ..`
Expected: build succeeds with no TS errors; `ui/dist/index.html` present.

- [ ] **Step 9: Commit**

```bash
git add ui/src/conversations-client.ts ui/src/conversations-client.test.ts ui/src/Sidebar.tsx ui/src/App.tsx ui/src/runtime.ts
git commit -m "feat(ui): conversation sidebar with list/new/delete + retomada via localStorage"
```

---

### Task 21: Static UI serving from backend

**Files:**
- Create: `src/server/routes/ui.ts`
- Modify: `src/server/app.ts`
- Test: `tests/server/routes/ui.test.ts`

Backend serves `ui/dist/` at the root path. Falls back to `index.html` for any unmatched path (SPA-friendly).

- [ ] **Step 1: Write failing test**

Create `/home/joao/augchatd/tests/server/routes/ui.test.ts`:

```typescript
import { test, expect, beforeAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../src/server/app';
import { createJwtModule } from '../../../src/auth/jwt';
import { createSessionStore } from '../../../src/auth/sessions';

const k = new TextEncoder().encode('A'.repeat(32));
let uiDir: string;

beforeAll(() => {
  uiDir = mkdtempSync(join(tmpdir(), 'aug-ui-'));
  writeFileSync(join(uiDir, 'index.html'), '<html>UI HERE</html>');
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log("ok");');
});

function build() {
  const sessions = createSessionStore();
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });
  return createApp({
    config: { mode: 'demo', listen: { host: '0', port: 0 }, hotDir: '/tmp', jwt: { currentKey: k, ttlSeconds: 600 } },
    sessions,
    jwt,
    versionSha: 'x',
    appVersion: '0',
    uiDir,
  });
}

test('GET / serves index.html', async () => {
  const app = build();
  const res = await app.request('/');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('UI HERE');
});

test('GET /assets/app.js serves the asset', async () => {
  const app = build();
  const res = await app.request('/assets/app.js');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('console.log');
});

test('GET /any/unknown/path falls back to index.html (SPA)', async () => {
  const app = build();
  const res = await app.request('/some/spa/route');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('UI HERE');
});

test('API routes still take precedence over SPA fallback', async () => {
  const app = build();
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test tests/server/routes/ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement UI route**

Create `/home/joao/augchatd/src/server/routes/ui.ts`:

```typescript
import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function uiRoutes(uiDir: string): Hono {
  const indexHtml = () => readFileSync(join(uiDir, 'index.html'));

  const app = new Hono();

  app.get('*', (c) => {
    const path = c.req.path === '/' ? '/index.html' : c.req.path;
    const full = join(uiDir, path);
    if (full.startsWith(uiDir) && existsSync(full) && path !== '/index.html') {
      const buf = readFileSync(full);
      const mime = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
      return new Response(buf, { headers: { 'Content-Type': mime } });
    }
    return new Response(indexHtml(), { headers: { 'Content-Type': MIME['.html']! } });
  });

  return app;
}
```

Modify `/home/joao/augchatd/src/server/app.ts`:

- Add `uiDir?: string` to `AppCtx`.
- Mount `uiRoutes(ctx.uiDir)` **last** (catch-all), only if `uiDir` is provided.

Replace `createApp`:

```typescript
import { Hono } from 'hono';
import type { LanguageModel } from 'ai';
import type { ProcessConfig } from '../config/env';
import type { SessionStore } from '../auth/sessions';
import type { JwtModule } from '../auth/jwt';
import { healthRoutes } from './routes/health';
import { demoRoutes } from './routes/demo';
import { conversationsRoutes } from './routes/conversations';
import { messagesRoutes } from './routes/messages';
import { uiRoutes } from './routes/ui';

export interface AppCtx {
  config: ProcessConfig;
  sessions: SessionStore;
  jwt: JwtModule;
  versionSha: string;
  appVersion: string;
  modelOverride?: LanguageModel;
  uiDir?: string;
}

export function createApp(ctx: AppCtx): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(ctx));
  app.route('/', demoRoutes(ctx));
  app.route('/', conversationsRoutes(ctx));
  app.route('/', messagesRoutes(ctx));
  if (ctx.uiDir) app.route('/', uiRoutes(ctx.uiDir));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => c.json({ error: 'internal_error', detail: String(err.message) }, 500));
  return app;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test tests/server/routes/ui.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: all green (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/routes/ui.ts tests/server/routes/ui.test.ts
git commit -m "feat(server): serve bundled UI from disk with SPA fallback"
```

---

### Task 22: Boot orchestration (src/index.ts)

**Files:**
- Create: `src/index.ts`

Wires everything together: parse env, build demo session (if demo mode), open JWT module, start Hono server with Bun.serve.

- [ ] **Step 1: Implement entry**

Create `/home/joao/augchatd/src/index.ts`:

```typescript
import { resolve } from 'node:path';
import { parseEnv } from './config/env';
import { buildDemoSession } from './config/demo';
import { createJwtModule } from './auth/jwt';
import { createSessionStore } from './auth/sessions';
import { createApp } from './server/app';
import { DEMO_SID } from './server/routes/demo';
import { log } from './log';

const APP_VERSION = '0.0.0';
const VERSION_SHA = process.env.AUGCHATD_VERSION_SHA ?? 'dev';

function main(): void {
  const cfg = parseEnv(process.env);
  const sessions = createSessionStore();
  const jwt = createJwtModule({
    currentKey: cfg.jwt.currentKey,
    previousKey: cfg.jwt.previousKey,
    ttlSeconds: cfg.jwt.ttlSeconds,
  });

  if (cfg.mode === 'demo') {
    const payload = buildDemoSession(process.env);
    sessions.put(DEMO_SID, {
      tenantId: 'urn:augchatd-tenant:demo',
      userId: payload.user_id,
      modelProvider: payload.model.provider,
      modelId: payload.model.model_id,
      modelApiKey: payload.model.api_key,
      systemPrompt: payload.system_prompt,
      storage: payload.storage,
      // Demo session entry lives for a long time; per-request TTL is the JWT exp.
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      stale: false,
    });
    log.info('demo_session_loaded', 'demo session installed in memory', {
      session_id: DEMO_SID,
      model_id: payload.model.model_id,
    });
  }

  const uiDir = process.env.AUGCHATD_UI_DIR ?? resolve(import.meta.dir, '..', 'ui', 'dist');

  const app = createApp({
    config: cfg,
    sessions,
    jwt,
    appVersion: APP_VERSION,
    versionSha: VERSION_SHA,
    uiDir,
  });

  const server = Bun.serve({
    hostname: cfg.listen.host,
    port: cfg.listen.port,
    fetch: app.fetch,
  });

  log.info('server_started', 'augchatd listening', {
    host: server.hostname,
    port: server.port,
    mode: cfg.mode,
  });

  const shutdown = (signal: string) => {
    log.info('shutdown', 'received signal, stopping server', { signal });
    server.stop(false);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
```

- [ ] **Step 2: Smoke test — start the server and hit /health**

In one terminal:
```bash
AUGCHATD_MODE=demo \
AUGCHATD_LISTEN=127.0.0.1:18080 \
AUGCHATD_HOT_DIR=./data/hot \
AUGCHATD_JWT_SIGNING_KEY_CURRENT=$(openssl rand -base64 32) \
DEMO_MODEL_PROVIDER=anthropic \
DEMO_MODEL_ID=claude-opus-4-7 \
DEMO_MODEL_API_KEY=dummy-key-for-smoketest \
DEMO_SYSTEM_PROMPT="Be brief." \
bun run src/index.ts
```

In another terminal:
```bash
curl -sf http://127.0.0.1:18080/health
curl -sf http://127.0.0.1:18080/demo/jwt
```
Expected: `{"ok":true}` and `{"jwt":"eyJ...", "expires_at":...}`. `Ctrl+C` to stop.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: boot orchestration — parse env, load demo session, start server"
```

---

### Task 23: End-to-end demo test

**Files:**
- Create: `tests/e2e/demo.test.ts`

Boots the full app in-process with a mocked LLM, exercises the demo JWT → POST messages → SSE flow.

- [ ] **Step 1: Write the e2e test**

Create `/home/joao/augchatd/tests/e2e/demo.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV1 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { createApp } from '../../src/server/app';
import { createJwtModule } from '../../src/auth/jwt';
import { createSessionStore } from '../../src/auth/sessions';
import { closeAllDbs } from '../../src/storage/db';
import { DEMO_SID } from '../../src/server/routes/demo';

const k = new TextEncoder().encode('A'.repeat(32));
let hotDir: string;
let uiDir: string;

beforeEach(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'aug-e2e-hot-'));
  uiDir = mkdtempSync(join(tmpdir(), 'aug-e2e-ui-'));
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<html>UI</html>');
});
afterEach(() => {
  closeAllDbs();
  rmSync(hotDir, { recursive: true, force: true });
  rmSync(uiDir, { recursive: true, force: true });
});

function model() {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: 'Hi ' },
          { type: 'text-delta', textDelta: 'there!' },
          {
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: { promptTokens: 1, completionTokens: 2 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

test('end-to-end demo: fetch JWT, post message, receive streamed response', async () => {
  const sessions = createSessionStore();
  sessions.put(DEMO_SID, {
    tenantId: 'urn:augchatd-tenant:demo',
    userId: 'demo-user',
    modelProvider: 'anthropic',
    modelId: 'claude-opus-4-7',
    modelApiKey: 'k',
    systemPrompt: 'be brief',
    expiresAt: Date.now() + 60_000,
    stale: false,
  });
  const jwt = createJwtModule({ currentKey: k, ttlSeconds: 600 });

  const app = createApp({
    config: { mode: 'demo', listen: { host: '0', port: 0 }, hotDir, jwt: { currentKey: k, ttlSeconds: 600 } },
    sessions,
    jwt,
    versionSha: 'sha',
    appVersion: '0.0.0',
    modelOverride: model(),
    uiDir,
  });

  // Step 1: UI loads
  const uiRes = await app.request('/');
  expect(uiRes.status).toBe(200);

  // Step 2: Demo JWT
  const jwtRes = await app.request('/demo/jwt');
  const { jwt: token } = (await jwtRes.json()) as { jwt: string };

  // Step 3: List conversations (empty)
  const listRes = await app.request('/conversations', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await listRes.json()).conversations).toEqual([]);

  // Step 4: Send message
  const convId = crypto.randomUUID();
  const chatRes = await app.request(`/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });
  expect(chatRes.status).toBe(200);
  const body = await chatRes.text();
  expect(body).toContain('Hi ');
  expect(body).toContain('there!');

  // Step 5: List conversations now has one
  const listAfter = await app.request('/conversations', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listAfterBody = (await listAfter.json()) as { conversations: Array<{ id: string }> };
  expect(listAfterBody.conversations.map((x) => x.id)).toEqual([convId]);

  // Step 6: Delete
  const delRes = await app.request(`/conversations/${convId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(delRes.status).toBe(204);
});
```

- [ ] **Step 2: Run, verify pass**

Run: `bun test tests/e2e/demo.test.ts`
Expected: 1 passing.

- [ ] **Step 3: Run full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/demo.test.ts
git commit -m "test(e2e): full demo flow with mocked LLM"
```

---

### Task 24: Dockerfile

**Files:**
- Create: `Dockerfile`

Multi-stage build: build the UI, then run the backend with `ui/dist` in place.

- [ ] **Step 1: Write the Dockerfile**

Create `/home/joao/augchatd/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM oven/bun:1.1-alpine AS ui-build
WORKDIR /app/ui
COPY ui/package.json ui/bun.lockb ./
RUN bun install --frozen-lockfile
COPY ui/ ./
RUN bun run build

FROM oven/bun:1.1-alpine AS backend-deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.1-alpine AS runtime
ARG AUGCHATD_VERSION_SHA=dev
WORKDIR /app
ENV NODE_ENV=production
ENV AUGCHATD_HOT_DIR=/var/lib/augchatd/hot
ENV AUGCHATD_LISTEN=0.0.0.0:8080
ENV AUGCHATD_UI_DIR=/app/ui/dist
ENV AUGCHATD_VERSION_SHA=${AUGCHATD_VERSION_SHA}

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY --from=ui-build /app/ui/dist ./ui/dist

RUN mkdir -p /var/lib/augchatd/hot
VOLUME /var/lib/augchatd/hot

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s \
  CMD wget -q -O - http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["bun", "run", "src/index.ts"]
```

- [ ] **Step 2: Build and smoke test the image**

Run:
```bash
docker build --build-arg AUGCHATD_VERSION_SHA=$(git rev-parse --short HEAD) -t augchatd:dev .
docker run --rm -p 18080:8080 \
  -e AUGCHATD_MODE=demo \
  -e AUGCHATD_JWT_SIGNING_KEY_CURRENT=$(openssl rand -base64 32) \
  -e DEMO_MODEL_PROVIDER=anthropic \
  -e DEMO_MODEL_ID=claude-opus-4-7 \
  -e DEMO_MODEL_API_KEY=dummy \
  -e DEMO_SYSTEM_PROMPT="Be brief." \
  augchatd:dev &
sleep 2
curl -sf http://127.0.0.1:18080/health
curl -sf http://127.0.0.1:18080/demo/jwt
docker stop $(docker ps -q --filter ancestor=augchatd:dev)
```
Expected: `/health` returns `{"ok":true}`; `/demo/jwt` returns a JWT.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: Dockerfile multi-stage (UI build + backend runtime)"
```

---

### Task 25: README quickstart verification with a real LLM key

**Files:**
- Modify: `README.md` (only the Quickstart section, if needed)

Manually verify the end-to-end flow with a real Anthropic key, prove the demo bullet in the existing README works as written, and update wording only if a step is incorrect.

- [ ] **Step 1: Start the container with a real key**

```bash
docker run --rm -p 8080:8080 \
  -e AUGCHATD_MODE=demo \
  -e AUGCHATD_JWT_SIGNING_KEY_CURRENT=$(openssl rand -base64 32) \
  -e DEMO_MODEL_PROVIDER=anthropic \
  -e DEMO_MODEL_ID=claude-opus-4-7 \
  -e DEMO_MODEL_API_KEY=$ANTHROPIC_API_KEY \
  -e DEMO_SYSTEM_PROMPT="You are a helpful assistant." \
  augchatd:dev
```

- [ ] **Step 2: Open browser to http://localhost:8080 and chat**

Expected: UI loads, fetches `/demo/jwt`, lets you send a message, and streams back a real response.

- [ ] **Step 3: If wording in README quickstart drifted from reality, update it**

Specifically: the existing README example uses `augchatd/augchatd` image (unpublished). For local dev, the README already labels the image as TBD. If you discover any flag or env var name mismatch, fix only that paragraph.

- [ ] **Step 4: Commit (only if README changed)**

```bash
git add README.md
git commit -m "docs: align README quickstart with actual demo env vars"
```

If nothing changed, skip the commit.

---

## Self-review

Run through the spec sections (clusters A–I in the architecture doc) and confirm each is covered by Fatia 1 scope or explicitly deferred:

- **Cluster A — Identity**
  - A.1 SAN URI tenant id → deferred (no mTLS in Fatia 1; demo uses fixed `urn:augchatd-tenant:demo`). ✓
  - A.2 JWT claims set → Task 6 (sign), all tests assert `sub`, `aud`, `sid`, `exp`. ✓
  - A.3 conversation lifecycle (implicit create, (tenant, user) scope) → Tasks 9, 14, 15, 16; UI list/retomada/delete in Task 20. ✓
  - A.4 session GC, refresh path, DELETE → partially: TTL via Task 7; DELETE /sessions/{id} **deferred to Fatia 2** (no public `POST /sessions` to pair with). Demo refresh = re-fetch `/demo/jwt`. ✓
- **Cluster B — JWT keys** → Task 6 implements `current`/`previous` with `kid`; env in Task 3. ✓
- **Cluster C — Storage** → Tasks 8–10 cover hot SQLite. Flush/cold/recovery **deferred to Fatia 2**. `flushed_at` column exists. ✓
- **Cluster D — Tool loop** → Streaming via Task 15. Parallelism/loop limits/MCP 401 stale path **deferred to Fatia 3** (no tools yet). Cancellation supported (AbortSignal passed). ✓
- **Cluster E — RAG** → entirely deferred to Fatia 4. ✓
- **Cluster F — postMessage** → Tasks 18, 19 implement 4 of 5 messages (`ready`, `jwt`, `auth-required`, `resize`). `augchatd:fatal` defined in protocol but no Fatia 1 trigger — per spec §4.4, reserved for future incompatibility errors. ✓
- **Cluster G — Process/deploy** → Task 22 sets up basic shutdown. Multi-tenant DB lifecycle: trivial here (single demo tenant). Graceful flush deferred. ✓
- **Cluster H — Config** → Tasks 3, 5 cover env parsing and demo builder. Restart-only rotation = inherent. ✓
- **Cluster I — Observability** → Task 2 logger; Task 11 `/health` + `/version`; sensitive-data exclusion is enforced by never logging request/response bodies (verified by no log statements containing such content). ✓

**Type consistency check:** `SessionEntry` shape used identically in `sessions.ts`, middleware, demo route, chat module, and tests. `MockLanguageModelV1` is the same in stream test and e2e test. `AppCtx` extended additively (added `modelOverride`, `uiDir` in later tasks); earlier tasks that don't use them remain compilable because they're optional.

**Placeholder scan:** every code step contains the complete code; every test step contains the actual assertions; every command shows the expected output category. No "TBD" or "implement later" in plan body.

---

## Out of scope (will be addressed in later fatias)

These are intentionally not in Fatia 1 — they belong to subsequent fatias per §2 of the architecture doc:

- **Fatia 2:** `POST /sessions` (mTLS), `DELETE /sessions/{id}`, S3 cold storage, flush/hydration, multi-tenant in practice, boot recovery scan.
- **Fatia 3:** MCP client (HTTP/SSE), parallel tool execution, MCP 401 → stale propagation, the `mcp_credentials_expired` data stream error event (currently dead code path).
- **Fatia 4:** RAG (OpenSearch or pgvector first, then the other).
- **Cross-cutting:** CSP `frame-ancestors` per tenant (always permissive in Fatia 1); `/metrics` endpoint; CLI subcommands; embedded single-binary build (`bun build --compile`).

---

## Plan complete

**Plan complete and saved to `docs/superpowers/plans/2026-05-21-augchatd-fatia-1-mvp-demo.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
