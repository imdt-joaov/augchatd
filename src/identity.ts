import type { Context, Next } from "hono";
import type { MtlsTrustVars } from "./mtls-trust.ts";

/**
 * Maps the parsed mTLS subject (set by `requireMtlsTrust`) to the
 * `{ tenantId, userId }` pair augchatd uses everywhere for isolation:
 * filesystem paths (`data/<tenantId>/<userId>.sqlite`), S3 prefixes,
 * log fields, in-memory session keying.
 *
 * Default rule:
 *   tenantId ← Subject DN attribute `O` (Organization)
 *   userId   ← Subject DN attribute `CN` (Common Name)
 *
 * The rule is deliberately fixed today — no env-overrides — because mTLS
 * deployments must agree on the cert-issuance policy before they can
 * deploy augchatd; baking the rule keeps that contract explicit.
 *
 * Both values pass through the same alphabet validation as `user_id` in
 * the demo session JSON (see [contract-storage-hot](../spec/src/behavior/contracts/storage-hot.md)
 * §"Identifier alphabet"): `[A-Za-z0-9._-]{1,100}`. A non-conforming DN
 * means the CA is issuing certs incompatible with the deployment — a
 * configuration bug, surfaced as 400 not 500.
 */

export type Identity = {
  tenantId: string;
  userId: string;
};

export type IdentityVars = {
  identity: Identity;
};

// Mirrors src/env.ts IDENT_RE and src/storage.ts sanitize() so the value
// extracted from the cert is the value that lands in filesystem paths.
const IDENT_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export async function requireIdentity(
  c: Context<{ Variables: MtlsTrustVars & IdentityVars }>,
  next: Next,
): Promise<Response | void> {
  const subject = c.var.mtlsSubject;
  if (!subject) {
    // The middleware chain is misconfigured: requireMtlsTrust must run
    // first. Surfacing this as 500 because it's an internal contract
    // violation, not something the client can fix.
    return c.json({ error: "identity_chain_misconfigured" }, 500);
  }
  const tenantId = subject.attrs.get("o");
  const userId = subject.attrs.get("cn");
  if (!tenantId || !userId) {
    return c.json({ error: "mtls_subject_incomplete" }, 400);
  }
  if (!IDENT_RE.test(tenantId) || !IDENT_RE.test(userId)) {
    return c.json({ error: "mtls_subject_invalid_alphabet" }, 400);
  }
  c.set("identity", { tenantId, userId });
  await next();
}
