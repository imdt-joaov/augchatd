import { sign, verify } from "hono/jwt";

/**
 * JWT minting and signature-only verification.
 *
 * Per adr-0005-jwt-signature-only: no DB lookup per request; the JWT
 * carries the session id and an exp, and the in-memory session registry
 * is the source of truth for credentials/scope at chat time.
 *
 * The HS256 secret is supplied by `initJwt()` at boot from
 * `BootConfig.jwt_secret` (env-sourced in prod, ephemeral in demo). Keeping
 * it stable across restarts is what lets a JWT survive a daemon bounce
 * until its own `exp`.
 */

const ALG = "HS256" as const;

let secret: string | null = null;

/**
 * Wires the symmetric HS256 secret. Must be called once at boot, before
 * any `mintJwt` / `verifyJwt`. The value comes from `BootConfig.jwt_secret`
 * — `src/env.ts` enforces presence + length in prod and falls back to an
 * ephemeral random value in demo.
 */
export function initJwt(boundSecret: string): void {
  if (boundSecret.length === 0) {
    throw new Error("initJwt: secret must be a non-empty string");
  }
  secret = boundSecret;
}

function requireSecret(): string {
  if (secret === null) {
    throw new Error(
      "JWT secret not initialized — initJwt() must run before mint/verify",
    );
  }
  return secret;
}

export type JwtPayload = {
  [key: string]: unknown;
  /** session_id this JWT authorizes against the in-memory registry. */
  sid: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expires-at, unix seconds. */
  exp: number;
};

export async function mintJwt(
  sessionId: string,
  ttlSeconds: number,
): Promise<{ jwt: string; expires_at: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const payload: JwtPayload = { sid: sessionId, iat: now, exp };
  const jwt = await sign(payload, requireSecret(), ALG);
  return { jwt, expires_at: new Date(exp * 1000).toISOString() };
}

/**
 * Returns the decoded payload if the signature is valid and the token is
 * not expired; null otherwise. Used by JWT-authenticated routes.
 */
export async function verifyJwt(jwt: string): Promise<JwtPayload | null> {
  try {
    const payload = await verify(jwt, requireSecret(), ALG);
    if (typeof payload.sid !== "string") return null;
    return payload as JwtPayload;
  } catch {
    return null;
  }
}
