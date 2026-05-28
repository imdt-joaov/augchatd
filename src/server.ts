import { Hono } from "hono";
import { healthzHandler } from "./routes/healthz.ts";
import { demoSessionsHandler } from "./routes/demo-sessions.ts";
import { demoPageHandler } from "./routes/demo-page.ts";
import { chatHandler } from "./routes/chat.ts";
import {
  createConversationHandler,
  deleteConversationHandler,
  getConversationReasoningHandler,
  listConversationConnectorsHandler,
  listConversationMessagesHandler,
  listConversationsHandler,
  setConversationConnectorStateHandler,
  setConversationModelHandler,
  setConversationReasoningHandler,
} from "./routes/conversations.ts";
import { listSessionModelsHandler } from "./routes/models.ts";
import { createSessionHandler } from "./routes/sessions.ts";
import { requireSession } from "./auth.ts";
import { requireMtlsTrust } from "./mtls-trust.ts";
import { requireIdentity } from "./identity.ts";
import { mountStaticUi } from "./routes/static-ui.ts";
import type { BootConfig } from "./env.ts";
import type { SessionConnectorState } from "./session-registry.ts";

/**
 * Build the Hono app for the current boot config.
 *
 * Demo mode (per contract-demo-mode):
 *   - GET  /healthz         — exposed
 *   - GET  /demo, /demo/*   — exposed; the "integrator" wrapper page
 *                              that iframes the UI and runs the
 *                              postMessage handshake against
 *                              POST /demo/sessions. The wildcard lets
 *                              /demo/c/<cid> resolve to the same page
 *                              so reloads preserve the conversation.
 *   - POST /demo/sessions   — exposed; mints a fresh session from the
 *                              boot-loaded local/demo_session.json
 *   - POST /chat            — exposed (JWT bearer; session from
 *                              POST /demo/sessions)
 *   - POST /sessions        — NOT mounted (returns 404 by default)
 *   - DELETE /sessions/*    — NOT mounted (returns 404 by default)
 *   - GET  /, /assets/*     — bundled UI (static)
 *
 * Production mode:
 *   - GET  /healthz      — exposed
 *   - POST /sessions     — exposed iff TRUSTED_PROXY=true (gated by
 *                          requireMtlsTrust + requireIdentity)
 *   - POST /chat, conversation CRUD, /session/models — JWT-bearer
 *   - DELETE /sessions/:id — to come (PR D)
 */
const API_PATHS = ["/healthz", "/demo", "/chat", "/sessions", "/conversations", "/session"];

export function createApp(
  config: BootConfig,
  demoShared: SessionConnectorState,
): Hono {
  const app = new Hono();

  app.get("/healthz", healthzHandler(config.mode));

  if (config.mode === "demo" && config.demo) {
    // Specific routes first so they win over the wildcard below.
    app.post(
      "/demo/sessions",
      demoSessionsHandler(config.demo, config.demo_ttl_seconds, demoShared),
    );
    app.get("/demo", demoPageHandler);
    // Wildcard so the wrapper page also serves /demo/c/<cid> etc. —
    // lets us mirror the iframe's internal route into a real URL path
    // (instead of a fragment) so it shows up in server logs.
    app.get("/demo/*", demoPageHandler);
    app.post("/chat", requireSession, chatHandler);
    app.post("/conversations", requireSession, createConversationHandler);
    app.get("/conversations", requireSession, listConversationsHandler);
    app.delete(
      "/conversations/:conversation_id",
      requireSession,
      deleteConversationHandler,
    );
    app.get(
      "/conversations/:conversation_id/connectors",
      requireSession,
      listConversationConnectorsHandler,
    );
    app.put(
      "/conversations/:conversation_id/connectors/:descriptive_id",
      requireSession,
      setConversationConnectorStateHandler,
    );
    app.put(
      "/conversations/:conversation_id/model",
      requireSession,
      setConversationModelHandler,
    );
    app.get(
      "/conversations/:conversation_id/reasoning",
      requireSession,
      getConversationReasoningHandler,
    );
    app.put(
      "/conversations/:conversation_id/reasoning",
      requireSession,
      setConversationReasoningHandler,
    );
    app.get("/session/models", requireSession, listSessionModelsHandler);
    app.get(
      "/conversations/:conversation_id/messages",
      requireSession,
      listConversationMessagesHandler,
    );
  }

  // Production session minting. Only mounted when the operator declared
  // a trusted proxy (adr-0012-out-of-process-tls); without it the route
  // would silently accept unauthenticated session-create requests, since
  // augchatd does not see the cert directly. The JWT-bearer chat routes
  // are mounted unconditionally in prod — they're protected by JWT, not
  // mTLS, and the JWT is only issuable through this gate.
  if (config.mode === "prod" && config.trusted_proxy) {
    app.post(
      "/sessions",
      requireMtlsTrust,
      requireIdentity,
      createSessionHandler(config.demo_ttl_seconds),
    );
    // JWT-bearer chat-time routes: same handlers as demo, just behind
    // the production session-creation gate.
    app.post("/chat", requireSession, chatHandler);
    app.post("/conversations", requireSession, createConversationHandler);
    app.get("/conversations", requireSession, listConversationsHandler);
    app.delete(
      "/conversations/:conversation_id",
      requireSession,
      deleteConversationHandler,
    );
    app.get(
      "/conversations/:conversation_id/connectors",
      requireSession,
      listConversationConnectorsHandler,
    );
    app.put(
      "/conversations/:conversation_id/connectors/:descriptive_id",
      requireSession,
      setConversationConnectorStateHandler,
    );
    app.put(
      "/conversations/:conversation_id/model",
      requireSession,
      setConversationModelHandler,
    );
    app.get(
      "/conversations/:conversation_id/reasoning",
      requireSession,
      getConversationReasoningHandler,
    );
    app.put(
      "/conversations/:conversation_id/reasoning",
      requireSession,
      setConversationReasoningHandler,
    );
    app.get("/session/models", requireSession, listSessionModelsHandler);
    app.get(
      "/conversations/:conversation_id/messages",
      requireSession,
      listConversationMessagesHandler,
    );
  }

  // UI serving is mode-agnostic; in prod the UI handshake gets the JWT
  // from the integrator parent page via postMessage (per contract-ui-handshake).
  mountStaticUi(app, (p) =>
    API_PATHS.some((api) => p === api || p.startsWith(`${api}/`)),
  );

  return app;
}
