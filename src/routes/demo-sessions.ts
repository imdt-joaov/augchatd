import type { Context } from "hono";
import { mintJwt } from "../jwt.ts";
import { bindDemoSession, type SessionConnectorState } from "../session-registry.ts";
import type { DemoModeConfig } from "../env.ts";

/** POST /demo/sessions — file-driven analogue of POST /sessions; see contract-demo-mode. */
export function demoSessionsHandler(
  demoConfig: DemoModeConfig,
  ttlSeconds: number,
  shared: SessionConnectorState,
) {
  return async (c: Context): Promise<Response> => {
    const sessionId = crypto.randomUUID();
    bindDemoSession(sessionId, demoConfig, shared);
    const { jwt, expires_at } = await mintJwt(sessionId, ttlSeconds);
    return c.json({
      session_id: sessionId,
      jwt,
      expires_at,
      theme: demoConfig.theme,
    });
  };
}
