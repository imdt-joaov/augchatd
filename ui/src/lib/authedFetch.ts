import type { MutableRefObject } from "react";

export type AuthedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RefreshJwt = () => Promise<{
  jwt: string;
  theme?: "light" | "dark";
}>;

/**
 * Build an authed fetch bound to a JWT ref. On 401 the caller's
 * `refreshJwt` runs once (the iframe ↔ parent handshake in production),
 * the ref is updated in place, and the original request is retried with
 * the new token. Any second 401 surfaces to the caller — single recovery
 * path per contract-jwt-refresh.
 */
export function createAuthedFetch(
  jwtRef: MutableRefObject<string>,
  refreshJwt: RefreshJwt,
): AuthedFetch {
  return async (input, init) => {
    const withAuth = (token: string): RequestInit => {
      const h = new Headers(init?.headers);
      h.set("Authorization", `Bearer ${token}`);
      return { ...init, headers: h };
    };
    const first = await fetch(input, withAuth(jwtRef.current));
    if (first.status !== 401) return first;
    try {
      const { jwt } = await refreshJwt();
      jwtRef.current = jwt;
    } catch {
      return first;
    }
    return fetch(input, withAuth(jwtRef.current));
  };
}
