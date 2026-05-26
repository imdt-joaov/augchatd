import type { Context } from "hono";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  type UIMessage,
} from "ai";
import { llmFor } from "../llm.ts";
import { isUpstreamUnauthorizedSentinel, toolsForActiveConnectors } from "../mcp.ts";
import { consumeRagHits, toolsForActiveRagConnectors } from "../rag.ts";
import { supportsReasoning } from "../reasoning.ts";
import type { SessionRecord } from "../session-registry.ts";
import { writeTraceEvent } from "../trace.ts";
import { markChatEnd, markChatStart } from "../chat-inflight.ts";
import {
  createConversation,
  getConversation,
  resolveModelId,
  resolveReasoningEnabled,
  snapshotActiveMap,
  upsertMessages,
} from "../conversation-registry.ts";

interface ChatRequestBody {
  /**
   * Thread / conversation id. Required: the client must first call
   * `POST /conversations` to register the id (per contract-connector-toggle).
   */
  id?: string;
  messages: UIMessage[];
}

// Tool-use loop depth. Generous (100) so paginated MCP flows can fetch
// all slices on their own — augchatd does not nudge the LLM to "answer
// with partial data" or be lazy about pagination. If the cap genuinely
// hits, the fallback below makes the truncation visible to the user.
const MAX_STEPS = 100;

/**
 * POST /chat — chat tool-use loop (partial, per contract-session-chat).
 *
 * Wired today:
 *   - JWT bearer auth (requireSession middleware sets `session` on ctx).
 *   - Session's model + key.
 *   - Tools from active MCP-type and RAG-type connectors merged into
 *     a single tool map.
 *   - Multi-step tool-use loop capped at MAX_STEPS via
 *     `stopWhen: stepCountIs(...)`. When the cap hits and the LLM
 *     hasn't produced a final text message yet, we inject a
 *     visible fallback into the UI stream so the user sees something
 *     (instead of a chat that just stops emitting after a flurry of
 *     tool calls).
 */
export async function chatHandler(c: Context): Promise<Response> {
  const session = c.get("session") as SessionRecord;

  let body: ChatRequestBody;
  try {
    body = (await c.req.json()) as ChatRequestBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "missing_messages" }, 400);
  }
  if (!body.id || typeof body.id !== "string") {
    return c.json({ error: "missing_conversation_id" }, 400);
  }

  const conversationId = body.id;
  // Auto-create on first observation. The capture-on-first-observation
  // rule from contract-connector-toggle is preserved by createConversation
  // (it snapshots default_active for each in-scope connector).
  const conversation =
    getConversation(conversationId, session) ??
    createConversation(session, conversationId);

  // Snapshot at the start of the turn — per contract-session-chat:
  // "active set is captured at the start of each chat turn". In-flight
  // toggles do not affect this turn.
  const activeMap = snapshotActiveMap(conversation, session);
  const modelId = resolveModelId(conversation, session);
  const reasoningEnabled = resolveReasoningEnabled(conversation, session);

  const mcpConnectors = session.connectors.filter((c) => c.type === "mcp");
  const ragConnectors = session.connectors.filter((c) => c.type === "rag");
  const tools = {
    ...toolsForActiveConnectors(mcpConnectors, activeMap),
    ...toolsForActiveRagConnectors(ragConnectors, activeMap),
  };

  const messages = await convertToModelMessages(body.messages);

  writeTraceEvent(conversationId, {
    type: "request",
    conversation_id: conversationId,
    session_id: session.session_id,
    user_id: session.user_id,
    model: {
      provider: session.model.provider,
      model_id: modelId,
      session_default_model_id: session.model.model_id,
    },
    system_prompt: session.system_prompt,
    connectors: session.connectors.map((c) => ({
      descriptive_id: c.descriptive_id,
      type: c.type,
      name: c.name,
      default_active: c.default_active,
      active: activeMap.get(c.descriptive_id) ?? c.default_active,
    })),
    messages: body.messages,
  });

  // Record the in-flight turn so PUT handlers can audit toggle/model
  // changes that race with the streaming response (contract-session-chat
  // §"Toggle audit"). The pair start/end is symmetric — `onFinish` fires
  // on both the happy and the abort paths.
  markChatStart(conversationId);

  const uiStream = createUIMessageStream<UIMessage>({
    // Passing originalMessages so onFinish.messages returns the FULL
    // updated thread (history + new assistant response), not just the
    // new response — needed for hot-storage persistence below.
    originalMessages: body.messages,
    onFinish: ({ messages }) => {
      markChatEnd(conversationId);
      // Persist the full updated thread to hot storage (idempotent
      // upsert keyed by message_id). Aborted streams still leave the
      // partial assistant message in `messages` — we store it; replay
      // sees it as-is, which is the right behavior for audit.
      try {
        upsertMessages(
          conversation,
          session,
          messages.map((m) => ({
            id: m.id,
            role: m.role,
            parts: m.parts,
            metadata: m.metadata,
          })),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`chat: upsertMessages failed for ${conversationId}: ${msg}`);
      }
    },
    execute: async ({ writer }) => {
      const result = streamText({
        model: llmFor(session, modelId),
        system: session.system_prompt,
        messages,
        // The SDK types providerOptions as Record<string, JSONObject>; our
        // values are JSON-compatible but TS can't prove deep equivalence
        // through nested `unknown`. Cast is local and the helper signature
        // is restrictive enough to keep this honest.
        providerOptions: reasoningProviderOptions(
          session.model.provider,
          modelId,
          reasoningEnabled,
        ) as Parameters<typeof streamText>[0]["providerOptions"],
        // Propagate client disconnect to the upstream provider and to any
        // tool calls in flight. Without this the LLM + every MCP / RAG
        // fetch run to completion after the browser closes, burning
        // tokens and connector quota. The AI SDK forwards this signal to
        // tool.execute()'s second arg too — mcp.ts and rag.ts use it to
        // abort their own upstream calls.
        abortSignal: c.req.raw.signal,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        stopWhen: stepCountIs(MAX_STEPS),
        onStepFinish: (step) => {
          // After each step, drain the per-tool-call RAG hits captured
          // by the retrieve tool and emit a `source-document` UI part
          // per hit. assistant-ui renders these as chips beneath the
          // message, so the LLM no longer has to paste inline citations.
          const sourceDocsEmitted: Array<{ sourceId: string; title: string }> = [];
          for (const tr of step.toolResults ?? []) {
            if (!tr.toolName.endsWith("__retrieve")) continue;
            const hits = consumeRagHits(tr.toolCallId);
            for (const h of hits) {
              const sourceId = `${tr.toolCallId}:${h.doc_id}`;
              writer.write({
                type: "source-document",
                sourceId,
                mediaType: "text/plain",
                title: h.title,
                providerMetadata: {
                  augchatd: {
                    source_descriptive_id: h.source_descriptive_id,
                    index: h.index,
                    doc_id: h.doc_id,
                    score: h.score ?? null,
                    snippet: h.snippet,
                  },
                },
              });
              sourceDocsEmitted.push({ sourceId, title: h.title });
            }
          }
          // C1 — surface upstream 401s detected by MCP tool execute. The
          // sentinel was returned in-band so the LLM sees it too; the
          // chat handler additionally writes a trace event so operators
          // can grep for the auth-expiry case independently of the LLM's
          // surfacing. The bundled UI does not consume this yet; the
          // future iteration (tracked in contract-jwt-refresh's PENDING
          // block) would also emit a custom UI data part here and the
          // iframe would translate it into the existing JWT-refresh
          // handshake (`augchatd:ready`).
          for (const tr of step.toolResults ?? []) {
            const out = (tr as { output?: unknown }).output;
            const connectorId = isUpstreamUnauthorizedSentinel(out);
            if (connectorId !== null) {
              writeTraceEvent(conversationId, {
                type: "upstream.unauthorized",
                conversation_id: conversationId,
                session_id: session.session_id,
                connector: connectorId,
                tool_call_id: tr.toolCallId,
                tool_name: tr.toolName,
              });
            }
          }
          writeTraceEvent(conversationId, {
            type: "step.finish",
            conversation_id: conversationId,
            session_id: session.session_id,
            step_number: step.stepNumber,
            text: step.text,
            reasoning_text: step.reasoningText,
            tool_calls: step.toolCalls,
            tool_results: step.toolResults,
            source_documents_emitted: sourceDocsEmitted,
            finish_reason: step.finishReason,
            usage: step.usage,
            warnings: step.warnings,
          });
        },
        onFinish: (event) => {
          writeTraceEvent(conversationId, {
            type: "response.finish",
            conversation_id: conversationId,
            session_id: session.session_id,
            finish_reason: event.finishReason,
            total_usage: event.totalUsage,
            step_count: event.steps.length,
          });
        },
        onError: ({ error }) => {
          // Client-disconnect surfaces here as an AbortError (the
          // abortSignal above propagates from the request). Tag it
          // distinctly so trace consumers can tell "user closed the
          // tab" from "provider exploded" without a regex on the
          // message body.
          const isAbort =
            error instanceof Error &&
            (error.name === "AbortError" ||
              error.message.toLowerCase().includes("aborted"));
          writeTraceEvent(conversationId, {
            type: isAbort ? "aborted" : "error",
            conversation_id: conversationId,
            session_id: session.session_id,
            message: error instanceof Error ? error.message : String(error),
            ...(isAbort
              ? {}
              : { stack: error instanceof Error ? error.stack : undefined }),
          });
        },
      });

      writer.merge(
        result.toUIMessageStream({
          // Attach the resolved model + provider as message metadata
          // on this response. assistant-ui surfaces it under
          // `message.metadata.custom`; the bundled UI renders a small
          // chip per assistant message so a user who switched models
          // mid-conversation can tell which model produced each reply.
          // Returning the same metadata on both 'start' and 'finish'
          // events is harmless (idempotent).
          messageMetadata: ({ part }) => {
            if (part.type === "start" || part.type === "finish") {
              return {
                augchatd: {
                  model_id: modelId,
                  provider: session.model.provider,
                },
              };
            }
            return undefined;
          },
        }),
      );

      // After the model stream completes, inspect why it stopped.
      // If we hit the step cap mid-tool-loop, emit a fallback text
      // part — otherwise the user sees a chat that ran a bunch of
      // tools and produced no message.
      const finishReason = await result.finishReason;
      if (finishReason === "tool-calls") {
        const id = `augchatd-fallback-${Date.now()}`;
        writer.write({ type: "text-start", id });
        writer.write({
          type: "text-delta",
          id,
          delta:
            `\n\n⚠ augchatd: hit the tool-use depth limit (${MAX_STEPS} steps) without a final answer. ` +
            `The retrieved data above is partial. Try a more specific question, or ask the assistant ` +
            `to summarize what it has so far.`,
        });
        writer.write({ type: "text-end", id });
      }
    },
  });

  return createUIMessageStreamResponse({ stream: uiStream });
}

/**
 * Reasoning models hide their internal reasoning tokens by default — only
 * the count comes back in `usage.reasoningTokens`, the actual content is
 * `null` on OpenAI's side (encrypted), absent on Anthropic's. Asking for a
 * "summary" turns it into streamable text the bundled UI renders inside a
 * collapsible "Reasoning" section (see App.tsx's `ReasoningPart`).
 *
 * Gated on model id (via supportsReasoning) because passing the provider
 * option to a model that isn't a reasoning model returns 400 from the
 * upstream API.
 *
 * Per-conversation `enabled` flag (contract-reasoning-toggle): when false,
 * we return `undefined` even for reasoning-capable models, so no
 * `reasoning-*` parts hit the UI stream. Note that for OpenAI o-series /
 * gpt-5 the model still spends `reasoning_tokens` server-side — the
 * toggle only suppresses the surfaced summary, not the reasoning itself.
 */
function reasoningProviderOptions(
  provider: string,
  modelId: string,
  enabled: boolean,
): Record<string, Record<string, unknown>> | undefined {
  if (!enabled) return undefined;
  if (!supportsReasoning(provider, modelId)) return undefined;
  if (provider === "openai") {
    return { openai: { reasoningSummary: "auto" } };
  }
  if (provider === "anthropic") {
    return {
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    };
  }
  return undefined;
}
