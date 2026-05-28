import type { Context, Next } from "hono";

/**
 * Trust-the-proxy middleware for the mTLS-protected control-plane routes
 * (POST /sessions, DELETE /sessions/:id). See
 * [adr-0012-out-of-process-tls](../spec/src/architecture/adrs/0012-out-of-process-tls.md):
 * augchatd does not terminate TLS itself; a reverse proxy (e.g. nginx)
 * does the mTLS handshake and forwards two headers:
 *
 *   X-Client-Cert-Verify:  "SUCCESS" when the proxy verified a valid client
 *                          certificate against its configured CA bundle.
 *   X-Client-Cert-Subject: the certificate's Subject DN in RFC 2253 form
 *                          (nginx `$ssl_client_s_dn`).
 *
 * This middleware enforces the gate ("Verify must be SUCCESS") and parses
 * the Subject DN into an attribute map (CN / OU / O / …) on `c.var.mtlsSubject`,
 * to be consumed by `requireIdentity` downstream.
 *
 * Security caveat: these headers carry no signature — anything that can
 * reach augchatd at the HTTP layer can forge them. The operator MUST
 * deploy augchatd so that only the trusted proxy can reach it (loopback,
 * unix socket, or a private network with no other ingress). Enabling
 * `TRUSTED_PROXY=true` is the operator's explicit promise that this is so;
 * `createApp` only mounts this middleware when the flag is set.
 */

export type MtlsSubject = {
  /** Subject DN attributes, lowercased keys: "cn", "o", "ou", … */
  attrs: Map<string, string>;
  /** Raw Subject header, preserved for logging / debugging. */
  raw: string;
};

export type MtlsTrustVars = {
  mtlsSubject: MtlsSubject;
};

const VERIFY_HEADER = "X-Client-Cert-Verify";
const SUBJECT_HEADER = "X-Client-Cert-Subject";

export async function requireMtlsTrust(
  c: Context<{ Variables: MtlsTrustVars }>,
  next: Next,
): Promise<Response | void> {
  const verify = c.req.header(VERIFY_HEADER);
  if (verify !== "SUCCESS") {
    // Same 401 posture as the JWT auth: opaque to the client, no detail
    // about whether the cert was absent vs. invalid vs. the header was
    // missing — that's information for the proxy's logs, not the user.
    return c.json({ error: "mtls_required" }, 401);
  }
  const subject = c.req.header(SUBJECT_HEADER);
  if (!subject || subject.length === 0) {
    return c.json({ error: "mtls_required" }, 401);
  }
  const attrs = parseSubjectDn(subject);
  if (attrs === null) {
    return c.json({ error: "mtls_subject_malformed" }, 400);
  }
  c.set("mtlsSubject", { attrs, raw: subject });
  await next();
}

/**
 * Parse an RFC 2253 / RFC 4514 Subject DN as emitted by nginx
 * `$ssl_client_s_dn`. The grammar in practice (for X.509 client certs
 * issued by a sane CA) is far narrower than RFC 2253's full set — we
 * support comma-separated `KEY=value` RDNs, where values are taken
 * verbatim and trimmed. Quoting, hex-escapes, multi-valued RDNs (`+`),
 * and BER-encoded values are NOT supported: a CA that issues such DNs
 * is hostile to identity-extraction use cases and outside this
 * deployment's scope.
 *
 * Returns `null` on any unparseable input — caller surfaces 400.
 */
function parseSubjectDn(dn: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const part of dn.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) return null;
    // Reject duplicates (e.g. two CN=…). A well-formed Subject DN has at
    // most one CN; two means we'd have to guess which one is identity.
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out.size > 0 ? out : null;
}
