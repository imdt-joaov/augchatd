import { mkdirSync, readFileSync } from "node:fs";
import { parseConnectors, type Connector } from "./connectors.ts";

export type AugchatdMode = "demo" | "prod";

export type UiTheme = "light" | "dark";

const DEMO_SESSION_FILE = "local/demo_session.json";

/**
 * Raised on any boot-time configuration problem the user can fix (missing
 * file, malformed JSON, wrong field type). `src/index.ts` catches this and
 * prints just `err.message` — no stack — so the friendly hint doesn't get
 * buried in a Bun trace.
 */
export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootConfigError";
  }
}

/**
 * Resolved demo-mode session payload. The shape mirrors the production
 * `POST /sessions` body literally — `local/demo_session.json` is a working
 * preview of what an integrator would send over HTTP. See
 * [contract-demo-mode] and [contract-session-create] under `spec/`.
 *
 * `storage` is held opaquely until contract-storage-flush parses it; boot
 * only checks presence (object) vs absence (hot-only).
 */
export interface DemoModeConfig {
  user_id: string;
  model: { provider: string; model_id: string; api_key: string };
  system_prompt: string;
  storage: Record<string, unknown> | undefined;
  connectors: Connector[];
  theme: UiTheme;
}

export interface BootConfig {
  mode: AugchatdMode;
  port: number;
  demo: DemoModeConfig | undefined;
  /**
   * JWT lifetime in seconds for demo-minted sessions. Deployment-level, not
   * per-session: production decides this in code, not in the integrator's
   * `POST /sessions` body. Demo reads `DEMO_TTL_SECONDS` (default 60).
   */
  demo_ttl_seconds: number;
  /**
   * Directory where per-conversation JSONL traces are appended. Unset =
   * tracing disabled (no overhead). Mode-agnostic.
   */
  trace_dir: string | undefined;
  /**
   * Symmetric HS256 secret used by src/jwt.ts. In prod, sourced from
   * AUGCHATD_JWT_SECRET (required, length≥32, not a known placeholder); in
   * demo, optional — if absent we generate a 32-byte random one and set
   * `jwt_secret_ephemeral=true`, which boots a warning. Keeping the secret
   * stable across restarts is what lets a JWT outlive a daemon bounce
   * until its `exp` (otherwise every restart invalidates every open
   * session).
   */
  jwt_secret: string;
  jwt_secret_ephemeral: boolean;
}

const DEFAULT_PORT = 8080;
const DEFAULT_DEMO_TTL_SECONDS = 60;
const JWT_SECRET_MIN_LEN = 32;

const PLACEHOLDER_API_KEYS = new Set(["sk-replace-me", "REPLACE_ME"]);
const PLACEHOLDER_JWT_SECRETS = new Set([
  "REPLACE_ME",
  "change-me",
  "changeme",
  "secret",
  "your-secret-here",
]);

// Identifiers that land in filesystem paths (`user_id`, `tenant_id`). The
// allowed alphabet mirrors src/storage.ts's `sanitize()` so the validated
// form is also the on-disk form. Rejecting up front lets us drop the
// sanitize-collision risk surfaced in the audit.
const IDENT_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export function loadBootConfig(): BootConfig {
  const mode = readMode();
  const { secret, ephemeral } = readJwtSecret(mode);
  return {
    mode,
    port: readPort(),
    demo: mode === "demo" ? readDemoConfig() : undefined,
    demo_ttl_seconds: readDemoTtl(),
    trace_dir: readTraceDir(),
    jwt_secret: secret,
    jwt_secret_ephemeral: ephemeral,
  };
}

function readJwtSecret(mode: AugchatdMode): { secret: string; ephemeral: boolean } {
  const raw = process.env.AUGCHATD_JWT_SECRET;
  if (raw && raw.length > 0) {
    if (raw.length < JWT_SECRET_MIN_LEN) {
      throw new BootConfigError(
        `AUGCHATD_JWT_SECRET must be at least ${JWT_SECRET_MIN_LEN} characters (got ${raw.length}). ` +
          `Generate one with: openssl rand -hex 32`,
      );
    }
    if (PLACEHOLDER_JWT_SECRETS.has(raw)) {
      throw new BootConfigError(
        `AUGCHATD_JWT_SECRET is set to a placeholder value (${JSON.stringify(raw)}). ` +
          `Generate a real one with: openssl rand -hex 32`,
      );
    }
    return { secret: raw, ephemeral: false };
  }
  if (mode === "prod") {
    throw new BootConfigError(
      `AUGCHATD_JWT_SECRET is required in production mode. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  // demo: ephemeral fallback. index.ts prints a warning so the operator
  // sees the implication (every restart invalidates open demo sessions).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return { secret: Buffer.from(bytes).toString("base64url"), ephemeral: true };
}

function readMode(): AugchatdMode {
  return process.env.AUGCHATD_MODE?.toLowerCase() === "demo" ? "demo" : "prod";
}

function readPort(): number {
  const raw = process.env.AUGCHATD_PORT ?? process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  // Strict: parseInt is lenient ("8080abc" → 8080), which silently boots on
  // the wrong port if the operator typo'd. Require a plain non-negative
  // integer string up front.
  if (!/^\d+$/.test(raw)) {
    throw new BootConfigError(`Invalid port: ${raw}`);
  }
  const n = Number.parseInt(raw, 10);
  if (n <= 0 || n > 65535) {
    throw new BootConfigError(`Invalid port: ${raw}`);
  }
  return n;
}

function readDemoTtl(): number {
  const raw = process.env.DEMO_TTL_SECONDS;
  if (!raw) return DEFAULT_DEMO_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new BootConfigError(`Invalid DEMO_TTL_SECONDS: ${raw}`);
  }
  return n;
}

function readTraceDir(): string | undefined {
  const raw = process.env.AUGCHATD_TRACE_DIR;
  if (!raw) return undefined;
  try {
    mkdirSync(raw, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BootConfigError(`AUGCHATD_TRACE_DIR could not be created at '${raw}': ${msg}`);
  }
  return raw;
}

function readDemoConfig(): DemoModeConfig {
  let text: string;
  try {
    text = readFileSync(DEMO_SESSION_FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BootConfigError(missingSessionFileMessage());
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new BootConfigError(`demo session config at ${DEMO_SESSION_FILE} could not be read: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BootConfigError(`${DEMO_SESSION_FILE}: not valid JSON (${(e as Error).message})`);
  }
  return validateSession(parsed);
}

function missingSessionFileMessage(): string {
  return [
    ``,
    `Demo session config not found at ${DEMO_SESSION_FILE}.`,
    ``,
    `A template is committed at ${DEMO_SESSION_FILE}.example. Copy it:`,
    ``,
    `    cp ${DEMO_SESSION_FILE}.example ${DEMO_SESSION_FILE}`,
    ``,
    `Then edit ${DEMO_SESSION_FILE} and fill in your model API key, S3`,
    `credentials, and connector list. See CONTRIBUTING.md → "Local development"`,
    `for the field-by-field walkthrough; the file shape mirrors the production`,
    `POST /sessions body.`,
    ``,
  ].join("\n");
}

function validateSession(value: unknown): DemoModeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("the session config must be a JSON object");
  }
  const o = value as Record<string, unknown>;

  const user_id = reqString(o["user_id"], "user_id");
  // user_id lands in a filesystem path: data/<tenantId>/<userId>.sqlite (see
  // contract-storage-hot). Restrict to a safe alphabet up front instead of
  // letting src/storage.ts sanitize() collapse e.g. "a/b" and "a_b" into one
  // file. The 100-char cap mirrors the sanitize() truncation. Demo's
  // tenant_id is hardcoded to "demo", so it does not need the same check
  // here; the production POST /sessions handler should reuse `IDENT_RE` for
  // its tenant_id (derived from the mTLS cert).
  if (!IDENT_RE.test(user_id)) {
    fail(
      `"user_id" must match ${IDENT_RE.source} (got ${JSON.stringify(user_id)})`,
    );
  }
  const system_prompt = reqString(o["system_prompt"], "system_prompt");
  const model = reqModel(o["model"]);

  // `storage` is optional and opaque; contract-storage-flush will parse it.
  // Demo accepts undefined (hot-only) or any object.
  const storageRaw = o["storage"];
  let storage: Record<string, unknown> | undefined;
  if (storageRaw === undefined) {
    storage = undefined;
  } else if (typeof storageRaw !== "object" || storageRaw === null || Array.isArray(storageRaw)) {
    fail(`"storage" must be an object when set`);
  } else {
    storage = storageRaw as Record<string, unknown>;
  }

  // parseConnectors throws plain Error (it's shared with future POST /sessions
  // handling, where the route should turn it into a 400). At boot, those would
  // skip the friendly clean-exit branch in src/index.ts — rewrap as
  // BootConfigError so the user sees a one-line message instead of a Bun stack.
  let connectors;
  try {
    connectors = parseConnectors(o["connectors"]);
  } catch (e) {
    fail((e as Error).message);
  }

  // theme is optional; default light.
  const themeRaw = o["theme"];
  let theme: UiTheme;
  if (themeRaw === undefined) {
    theme = "light";
  } else if (themeRaw === "light" || themeRaw === "dark") {
    theme = themeRaw;
  } else {
    fail(`"theme" must be "light" or "dark" (got ${JSON.stringify(themeRaw)})`);
  }

  return { user_id, model, system_prompt, storage, connectors, theme };
}

function reqString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`"${key}" must be a non-empty string`);
  }
  return value as string;
}

function reqModel(value: unknown): DemoModeConfig["model"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`"model" must be an object`);
  }
  const m = value as Record<string, unknown>;
  const provider = reqString(m["provider"], "model.provider");
  const model_id = reqString(m["model_id"], "model.model_id");
  const api_key = reqString(m["api_key"], "model.api_key");
  // Catch the most common first-run mistake: copying the template and
  // forgetting to swap the placeholder. Without this, boot succeeds and the
  // very first chat 401s from the upstream provider — opaque and slow to
  // diagnose.
  if (PLACEHOLDER_API_KEYS.has(api_key)) {
    fail(
      `"model.api_key" still has the template placeholder ("${api_key}"). ` +
        `Edit ${DEMO_SESSION_FILE} and set your real API key.`,
    );
  }
  return { provider, model_id, api_key };
}

function fail(detail: string): never {
  throw new BootConfigError(`${DEMO_SESSION_FILE}: ${detail}`);
}
