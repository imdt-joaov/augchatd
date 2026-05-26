import type {
  RemoteThreadListAdapter,
  ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import type { UIMessage } from "ai";
import type { AuthedFetch } from "./authedFetch";

// RemoteThreadMetadata / RemoteThreadInitializeResponse aren't re-exported
// from @assistant-ui/react; derive them from the adapter contract so we
// don't import @assistant-ui/core directly.
type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["fetch"]>
>;

interface ConversationsListResponse {
  conversations: ReadonlyArray<{
    conversation_id: string;
    title: string | null;
    message_count: number;
    model_id_override: string | null;
    updated_at: string;
  }>;
}

interface MessagesResponse {
  messages: ReadonlyArray<{
    message_id: string;
    role: string;
    parts: unknown;
    metadata?: unknown;
  }>;
}

async function fetchListItem(
  authedFetch: AuthedFetch,
  cid: string,
): Promise<RemoteThreadMetadata | undefined> {
  const r = await authedFetch("/conversations");
  if (!r.ok) throw new Error(`GET /conversations HTTP ${r.status}`);
  const data = (await r.json()) as ConversationsListResponse;
  const row = data.conversations.find((c) => c.conversation_id === cid);
  if (!row) return undefined;
  return {
    remoteId: row.conversation_id,
    status: "regular",
    ...(row.title !== null ? { title: row.title } : {}),
  };
}

/**
 * RemoteThreadListAdapter backed by augchatd's `/conversations` REST surface.
 *
 * The server has no archive/unarchive/rename endpoints; the UI hides Archive
 * (see ui/src/components/assistant-ui/thread-list.tsx) and the runtime never
 * calls rename. Those methods stay as no-ops so the adapter type is satisfied.
 *
 * The server auto-derives a title from the first user message in
 * conversation-registry.ts; `generateTitle` mirrors that derived title back
 * to the runtime so the list updates without a manual reload.
 */
export function createThreadListAdapter(
  authedFetch: AuthedFetch,
): RemoteThreadListAdapter {
  return {
    async list() {
      const r = await authedFetch("/conversations");
      if (!r.ok) throw new Error(`GET /conversations HTTP ${r.status}`);
      const data = (await r.json()) as ConversationsListResponse;
      const threads: RemoteThreadMetadata[] = data.conversations.map((c) => ({
        remoteId: c.conversation_id,
        status: "regular",
        ...(c.title !== null ? { title: c.title } : {}),
      }));
      return { threads };
    },

    async initialize() {
      const r = await authedFetch("/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error(`POST /conversations HTTP ${r.status}`);
      const { conversation_id } = (await r.json()) as {
        conversation_id: string;
      };
      return { remoteId: conversation_id, externalId: undefined };
    },

    async rename() {
      /* server has no rename endpoint; title is server-derived */
    },

    async archive() {
      /* server has no archive endpoint; UI hides the Archive button */
    },

    async unarchive() {
      /* mirror archive */
    },

    async delete(remoteId) {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(remoteId)}`,
        { method: "DELETE" },
      );
      if (!r.ok && r.status !== 404) {
        throw new Error(`DELETE /conversations/${remoteId} HTTP ${r.status}`);
      }
    },

    async fetch(remoteId) {
      const row = await fetchListItem(authedFetch, remoteId);
      if (!row) throw new Error(`conversation_not_found: ${remoteId}`);
      return row;
    },

    async generateTitle(remoteId) {
      return createAssistantStream(async (controller) => {
        const row = await fetchListItem(authedFetch, remoteId);
        controller.appendText(row?.title ?? "");
      });
    },
  };
}

/**
 * Per-thread history adapter for the AI SDK chat runtime. The AI SDK path
 * uses `withFormat(fmt)` exclusively (`load`/`append` at the top level are
 * unused — required only to satisfy the type). `fmt` is the `ai-sdk/v6`
 * MessageFormatAdapter; we feed `fmt.decode` storage rows constructed from
 * `GET /conversations/:cid/messages`.
 *
 * `append` is a no-op: the server persists messages during the `/chat`
 * stream (see chat.ts), so client-side append would double-write.
 *
 * `cidRef` is read lazily at load time, so the same adapter instance works
 * before and after `initialize()` resolves a remoteId for a fresh thread.
 */
export function createHistoryAdapter(
  authedFetch: AuthedFetch,
  cidRef: { readonly current: string | undefined },
): ThreadHistoryAdapter {
  return {
    async load() {
      return { messages: [] };
    },
    async append() {},
    withFormat(fmt) {
      return {
        async load() {
          const cid = cidRef.current;
          if (!cid) return { messages: [] };
          const r = await authedFetch(
            `/conversations/${encodeURIComponent(cid)}/messages`,
          );
          if (!r.ok) {
            throw new Error(
              `GET /conversations/${cid}/messages HTTP ${r.status}`,
            );
          }
          const data = (await r.json()) as MessagesResponse;
          const items = [];
          let parentId: string | null = null;
          for (const m of data.messages) {
            const content = {
              role: m.role,
              parts: m.parts,
              ...(m.metadata !== undefined && m.metadata !== null
                ? { metadata: m.metadata }
                : {}),
            } as unknown as Omit<UIMessage, "id">;
            items.push(
              fmt.decode({
                id: m.message_id,
                parent_id: parentId,
                format: fmt.format,
                content: content as unknown as Parameters<
                  typeof fmt.decode
                >[0]["content"],
              }),
            );
            parentId = m.message_id;
          }
          return {
            messages: items,
            ...(parentId !== null ? { headId: parentId } : {}),
          };
        },
        async append() {},
      };
    },
  };
}
