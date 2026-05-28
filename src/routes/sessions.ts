import type { Context } from "hono";
import { z } from "zod";
import { mintJwt } from "../jwt.ts";
import { bindSession } from "../session-registry.ts";
import { initMcpConnectors } from "../mcp.ts";
import { initRagConnectors } from "../rag.ts";
import { parseConnectors } from "../connectors.ts";
import { listProviderModels } from "../provider-models.ts";
import { coldStorageConfigFrom, probeWritability } from "../cold-storage.ts";
import type { Identity, IdentityVars } from "../identity.ts";
import type { MtlsTrustVars } from "../mtls-trust.ts";
import type { UiTheme } from "../env.ts";

/**
 * POST /sessions — production session creation (contract-session-create).
 *
 * Mounted only when `mode=prod` AND `TRUSTED_PROXY=true` (see
 * [adr-0012-out-of-process-tls](../../spec/src/architecture/adrs/0012-out-of-process-tls.md)),
 * downstream of `requireMtlsTrust` + `requireIdentity` — so `c.var.identity`
 * carries the cert-derived `{ tenantId, userId }` pair by the time we run.
 * The request body's `user_id` is required and authoritative (the
 * integrator's backend tells us which of THEIR users this session is for);
 * the cert's CN is a sanity-checked sibling but not the source of truth.
 *
 * Steps mirror the demo (boot-time) and the contract:
 *   1. Validate the body shape via zod, including identifier alphabet.
 *   2. parseConnectors() — same validator the demo uses on local/demo_session.json.
 *   3. Probe the LLM credential (provider list-models).
 *   4. Probe S3 writability when storage is supplied.
 *   5. bindSession() — allocates fresh per-session MCP/RAG client Maps.
 *   6. initMcpConnectors / initRagConnectors against those Maps (credentials
 *      stay inside the SessionRecord; no module-level singletons).
 *   7. mintJwt() and return { session_id, jwt, expires_at }.
 *
 * On any 4xx the session is not registered (`bindSession` is the last
 * step before mint).
 */

const IDENT_RE_SOURCE = "^[a-zA-Z0-9._-]{1,100}$";
const IDENT_RE = new RegExp(IDENT_RE_SOURCE);

const ModelSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  api_key: z.string().min(1),
});

const PayloadSchema = z.object({
  user_id: z.string().regex(IDENT_RE, {
    message: `"user_id" must match ${IDENT_RE_SOURCE}`,
  }),
  system_prompt: z.string().min(1),
  model: ModelSchema,
  storage: z
    .record(z.string(), z.unknown())
    .optional(),
  connectors: z.unknown().optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

export function createSessionHandler(ttlSeconds: number) {
  return async (
    c: Context<{ Variables: MtlsTrustVars & IdentityVars }>,
  ): Promise<Response> => {
    const identity = c.var.identity as Identity;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = PayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", detail: parsed.error.issues },
        400,
      );
    }
    const body = parsed.data;

    // parseConnectors throws plain Error on invalid input — 400 to the
    // client. Empty / absent connectors[] is fine (plain chat).
    let connectors;
    try {
      connectors = parseConnectors(body.connectors);
    } catch (err) {
      return c.json(
        {
          error: "invalid_connectors",
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    // Probe the LLM credential. Same posture as demo boot — a wrong key
    // gets caught here, before any session/JWT exists, so the integrator
    // can react synchronously instead of via a stream-side 5xx.
    try {
      await listProviderModels(body.model.provider, body.model.api_key);
    } catch (err) {
      return c.json(
        {
          error: "llm_credential_probe_failed",
          provider: body.model.provider,
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    // Probe S3 writability when storage is configured.
    let coldConfig;
    try {
      coldConfig = coldStorageConfigFrom(body.storage);
    } catch (err) {
      return c.json(
        {
          error: "invalid_storage",
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
    if (coldConfig) {
      try {
        await probeWritability(coldConfig);
      } catch (err) {
        return c.json(
          {
            error: "s3_writability_probe_failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          400,
        );
      }
    }

    const sessionId = crypto.randomUUID();
    const theme: UiTheme = body.theme ?? "light";
    const session = bindSession({
      sessionId,
      tenantId: identity.tenantId,
      userId: body.user_id,
      systemPrompt: body.system_prompt,
      model: body.model,
      storage: body.storage,
      connectors,
      theme,
    });

    // Per-session connector init — populates session.mcpClients /
    // session.ragClients. The handshake is best-effort: a connector
    // whose server is down at this point is logged-and-skipped (chat
    // still works without it; this matches the demo boot posture).
    const mcpConnectors = connectors.filter((c) => c.type === "mcp");
    const ragConnectors = connectors.filter((c) => c.type === "rag");
    if (mcpConnectors.length > 0) {
      await initMcpConnectors(mcpConnectors, session.mcpClients);
    }
    if (ragConnectors.length > 0) {
      await initRagConnectors(
        ragConnectors,
        session.ragClients,
        session.ragHitsByToolCall,
      );
    }

    const { jwt, expires_at } = await mintJwt(sessionId, ttlSeconds);
    return c.json({ session_id: sessionId, jwt, expires_at });
  };
}
