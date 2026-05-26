import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { useMessage } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { MarkdownText } from "./Markdown.tsx";
import { ToolCallBlock, ToolGroup } from "./blocks/ToolCallBlock.tsx";
import { SourceBlock } from "./blocks/SourceBlock.tsx";
import { ConnectorsMenu } from "./ConnectorsMenu.tsx";
import { ComposerOptionsMenu } from "./ComposerOptionsMenu.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createAuthedFetch, type AuthedFetch } from "@/lib/authedFetch";

interface BootState {
  cid: string;
  initialMessages: UIMessage[];
}
// CitationsPanel temporarily removed — the useThread selector returned a
// new array each render, triggering React error #185 (max update depth).
// Reintroduce with the imperative useThreadRuntime + subscribe pattern
// when RAG-type connectors actually emit source-url / source-document
// parts. Tracked in augchatd/augchatd#5.

interface HealthState {
  mode: "demo" | "prod";
  status: string;
}

const SUGGESTIONS = [
  "Show me a Mermaid flowchart for an HTTP request.",
  "Render a small JSON object for a user record.",
  "Explain Euler's identity with LaTeX.",
];

/**
 * augchatd bundled UI.
 *
 * Per contract-demo-mode + contract-ui-handshake:
 *  - This SPA is meant to run inside an iframe; the parent page supplies
 *    the JWT via postMessage (the augchatd:ready / augchatd:jwt
 *    handshake). Same flow in demo (parent = demo wrapper at /demo/)
 *    and prod (parent = integrator's app page).
 *  - Boots, calls /healthz for the mode (used for the demo banner).
 *  - If running top-level (no iframe parent) it shows a guidance
 *    message instead of hanging on the handshake.
 *  - Shows a "Demo session — not authenticated" banner in demo mode
 *    from inside the augchatd origin (parent cannot style or hide it).
 *  - Hands the JWT to the chat runtime; on 401 the JWT is re-fetched
 *    via a second handshake (per contract-jwt-refresh, single recovery
 *    path).
 */
export default function App() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [jwtReady, setJwtReady] = useState(false);
  const [boot, setBoot] = useState<BootState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  // jwtRef is shared by every authed request (chat transport, list
  // sidebar, model picker, connector toggle). The handshake-driven
  // refresh updates it in place; setting state would re-render the
  // whole subtree and tear down the chat runtime.
  const jwtRef = useRef<string>("");

  const refreshJwt = useCallback(async () => {
    const { jwt, theme } = await requestJwtFromParent();
    jwtRef.current = jwt;
    applyTheme(theme);
    return { jwt, theme };
  }, []);

  const authedFetch = useMemo(
    () => createAuthedFetch(jwtRef, refreshJwt),
    [refreshJwt],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await fetch("/healthz").then((r) => r.json() as Promise<HealthState>);
        if (cancelled) return;
        setHealth(h);

        // This SPA must run inside an iframe — the parent supplies the
        // JWT via postMessage. Loading at top-level is a misconfig; tell
        // the user where to go instead of hanging on a handshake that
        // can never complete.
        if (window.parent === window) {
          setError(
            h.mode === "demo"
              ? "augchatd: this UI runs inside an iframe — open /demo/ instead of /."
              : "augchatd: this UI must be embedded by an integrator page (postMessage handshake required).",
          );
          return;
        }

        const { jwt, theme } = await requestJwtFromParent();
        if (cancelled) return;
        applyTheme(theme);
        jwtRef.current = jwt;
        setJwtReady(true);

        const b = await resolveBootConversation(jwt);
        if (cancelled) return;
        setBoot(b);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bumpRefetch = useCallback(() => {
    setRefetchKey((k) => k + 1);
  }, []);

  const newConversation = useCallback(async () => {
    const r = await authedFetch("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`POST /conversations HTTP ${r.status}`);
    const { conversation_id } = (await r.json()) as { conversation_id: string };
    setIframeRoute(`/c/${conversation_id}`);
    setBoot({ cid: conversation_id, initialMessages: [] });
    bumpRefetch();
  }, [authedFetch, bumpRefetch]);

  const switchConversation = useCallback(
    async (cid: string) => {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(cid)}/messages`,
      );
      if (!r.ok) {
        throw new Error(`GET /conversations/${cid}/messages HTTP ${r.status}`);
      }
      const data = (await r.json()) as {
        messages: Array<{
          message_id: string;
          role: string;
          parts: unknown;
          metadata?: unknown;
        }>;
      };
      const initialMessages: UIMessage[] = (data.messages ?? []).map((m) => ({
        id: m.message_id,
        role: m.role as UIMessage["role"],
        parts: m.parts as UIMessage["parts"],
        ...(m.metadata !== undefined && m.metadata !== null
          ? { metadata: m.metadata as UIMessage["metadata"] }
          : {}),
      }));
      setIframeRoute(`/c/${cid}`);
      setBoot({ cid, initialMessages });
    },
    [authedFetch],
  );

  const deleteConversation = useCallback(
    async (cid: string) => {
      const r = await authedFetch(`/conversations/${encodeURIComponent(cid)}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 404) {
        throw new Error(`DELETE /conversations/${cid} HTTP ${r.status}`);
      }
      if (boot && boot.cid === cid) {
        await newConversation();
      } else {
        bumpRefetch();
      }
    },
    [authedFetch, boot, newConversation, bumpRefetch],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-destructive">
        augchatd: {error}
      </div>
    );
  }
  if (!health || !jwtReady || !boot) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
        Loading…
      </div>
    );
  }

  // switchConversation / deleteConversation / refetchKey are consumed
  // by the sidebar wired in a later step; void them here so TS stays
  // clean while the actions remain available at App scope.
  void switchConversation;
  void deleteConversation;
  void refetchKey;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        {health.mode === "demo" && <DemoBanner />}
        <ChatRoom
          key={boot.cid}
          jwtRef={jwtRef}
          authedFetch={authedFetch}
          conversationId={boot.cid}
          initialMessages={boot.initialMessages}
          onFirstMessage={bumpRefetch}
        />
      </div>
    </TooltipProvider>
  );
}

function DemoBanner() {
  return (
    <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-[13px] font-medium tracking-wide text-destructive">
      Demo session — not authenticated
    </div>
  );
}

/**
 * Resolve which conversation_id to use on boot, hydrating server-side
 * messages when possible. URL convention: `/c/<conversation_id>`.
 *
 *   no path / unknown cid → mint a fresh conversation, replaceState
 *   /c/<cid> with messages → hydrate
 *   /c/<cid> with 404      → mint fresh + replaceState
 *
 * Auth boundary is implicit: the per-(tenant, user) SQLite partition
 * makes cids from other users resolve to `conversation_not_found`. No
 * extra check needed here.
 */
async function resolveBootConversation(jwt: string): Promise<BootState> {
  const match = /^\/c\/([^/?#]+)/.exec(window.location.pathname);
  const urlCid = match?.[1];

  if (urlCid) {
    const r = await fetch(`/conversations/${encodeURIComponent(urlCid)}/messages`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (r.ok) {
      const data = (await r.json()) as {
        messages: Array<{
          message_id: string;
          role: string;
          parts: unknown;
          metadata?: unknown;
        }>;
      };
      const initialMessages: UIMessage[] = (data.messages ?? []).map((m) => ({
        id: m.message_id,
        role: m.role as UIMessage["role"],
        parts: m.parts as UIMessage["parts"],
        // metadata is what carries the per-message {augchatd: {model_id, provider}}
        // emitted by chat.ts's messageMetadata callback. Hydrating it lets the
        // assistant-message chip work after a page reload.
        ...(m.metadata !== undefined && m.metadata !== null
          ? { metadata: m.metadata as UIMessage["metadata"] }
          : {}),
      }));
      return { cid: urlCid, initialMessages };
    }
    // 404 (or other) — fall through to mint fresh.
  }

  // Mint via POST /conversations. Server returns a UUID.
  const r = await fetch("/conversations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!r.ok) throw new Error(`POST /conversations HTTP ${r.status}`);
  const { conversation_id } = (await r.json()) as { conversation_id: string };
  setIframeRoute(`/c/${conversation_id}`);
  return { cid: conversation_id, initialMessages: [] };
}

/** Update the iframe's route and notify the parent so it can mirror the path. */
function setIframeRoute(path: string): void {
  window.history.replaceState(null, "", path);
  window.parent.postMessage(
    { type: "augchatd:route", path },
    document.referrer,
  );
}

/**
 * iframe ↔ parent handshake (contract-ui-handshake). Re-callable — each
 * call requests a fresh JWT, so 401 recovery uses the same code path.
 */
function requestJwtFromParent(
  timeoutMs = 10000,
): Promise<{ jwt: string; theme?: "light" | "dark" }> {
  return new Promise((resolve, reject) => {
    const referrer = document.referrer
    const handler = (e: MessageEvent) => {
      // if (e.origin !== referrer) return;
      const d = e.data as { type?: string; jwt?: unknown; theme?: unknown } | undefined;
      if (d?.type !== "augchatd:jwt" || typeof d.jwt !== "string") return;
      window.removeEventListener("message", handler);
      clearTimeout(timer);
      const theme =
        d.theme === "dark" || d.theme === "light" ? d.theme : undefined;
      resolve({ jwt: d.jwt, theme });
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(
        new Error(
          `augchatd: parent did not reply to augchatd:ready within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    window.addEventListener("message", handler);
    window.parent.postMessage({ type: "augchatd:ready" }, referrer);
  });
}

/**
 * Apply the session's theme to the document root. Default (`light`,
 * absent) leaves no attribute — the `:root` CSS vars in index.css are
 * the light palette. `dark` sets `data-theme="dark"`, which overrides
 * the CSS vars to the dark palette.
 */
function applyTheme(theme: "light" | "dark" | undefined): void {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function ChatRoom({
  jwtRef,
  authedFetch,
  conversationId,
  initialMessages,
  onFirstMessage,
}: {
  jwtRef: React.MutableRefObject<string>;
  authedFetch: AuthedFetch;
  conversationId: string;
  initialMessages: UIMessage[];
  onFirstMessage: () => void;
}) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/chat",
        headers: () => ({ Authorization: `Bearer ${jwtRef.current}` }),
        fetch: async (input, init) => {
          const r = await fetch(input, init);
          if (r.status !== 401) return r;
          try {
            const { jwt, theme } = await requestJwtFromParent();
            jwtRef.current = jwt;
            applyTheme(theme);
          } catch {
            return r;
          }
          const retriedHeaders = new Headers(init?.headers);
          retriedHeaders.set("Authorization", `Bearer ${jwtRef.current}`);
          return fetch(input, { ...init, headers: retriedHeaders });
        },
        // Override `body.id` to use OUR conversation_id (the one in
        // the URL / hydrated from POST /conversations) instead of the
        // assistant-ui-internal threadListItem.id. assistant-ui's id
        // stays client-local; the server sees only our cid, which is
        // what the SQLite row keys on.
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: { id: conversationId, messages, trigger, messageId },
        }),
      }),
    [conversationId],
  );

  const runtime = useChatRuntime({ transport, messages: initialMessages });

  // The server-derived conversation title comes from the first user
  // message (deriveTitle in conversation-registry.ts). Fire once per
  // mount, on the 0→≥1 transition of thread.messages, so the parent's
  // sidebar list refetches and shows the freshly-minted title without
  // waiting on the next user action.
  const firedFirstMessageRef = useRef(false);
  useEffect(() => {
    firedFirstMessageRef.current = initialMessages.length > 0;
    const unsubscribe = runtime.thread.subscribe(() => {
      if (firedFirstMessageRef.current) return;
      const count = runtime.thread.getState().messages.length;
      if (count >= 1) {
        firedFirstMessageRef.current = true;
        onFirstMessage();
      }
    });
    return unsubscribe;
  }, [runtime, initialMessages, onFirstMessage]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-4 py-8">
            <ThreadPrimitive.Empty>
              <EmptyState />
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage }}
            />
          </div>
        </ThreadPrimitive.Viewport>
        <Composer conversationId={conversationId} authedFetch={authedFetch} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-1 text-foreground">Try a question.</div>
        <div className="mb-4 text-[13px] text-muted-foreground">
          The session uses the model and key bound at boot from env vars.
        </div>
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((text) => (
            <ThreadPrimitive.Suggestion
              key={text}
              prompt={text}
              method="replace"
              autoSend
              asChild
            >
              <Button variant="secondary" size="sm" className="rounded-full">
                {text}
              </Button>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        You
      </div>
      <div className="rounded-2xl rounded-tr-md border bg-muted px-4 py-2.5 max-w-[85%] whitespace-pre-wrap">
        <MessagePrimitive.Parts components={{ Image: ImagePart }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Assistant
        </span>
        <ModelChip />
      </div>
      <div className="rounded-2xl rounded-tl-md border bg-card text-card-foreground px-4 py-3 max-w-[95%]">
        {/* While the response is still in flight and no content has
            arrived (no text-delta, no tool-call), the bubble was
            collapsing to a thin empty rectangle that looked broken.
            Three pulsing dots fill the gap; they disappear as soon
            as any part lands. */}
        <MessagePrimitive.If hasContent={false}>
          <ThinkingDots />
        </MessagePrimitive.If>
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Image: ImagePart,
            Reasoning: ReasoningPart,
            Source: SourceBlock,
            tools: { Fallback: ToolCallBlock },
            ToolGroup,
          }}
        />
      </div>
      <div className="mt-1 flex items-center gap-1 text-muted-foreground">
        <AssistantActionBar />
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Per-assistant-message provenance chip. Reads the model_id stamped by
 * the chat backend's `messageMetadata` callback (chat.ts) via
 * `useMessage` — surfaces a small "🤖 gpt-5-mini" label so a user who
 * switched models mid-conversation can tell which model produced each
 * reply. Renders nothing if the metadata is absent (e.g. messages
 * stored before this column was added).
 */
function ModelChip() {
  const modelId = useMessage(
    (s) =>
      (s.metadata?.custom as { augchatd?: { model_id?: string } } | undefined)
        ?.augchatd?.model_id,
  );
  if (!modelId) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
          <span aria-hidden>🤖</span>
          <span className="font-mono">{modelId}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Generated by {modelId}</TooltipContent>
    </Tooltip>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5" aria-label="thinking">
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: "300ms" }}
      />
    </div>
  );
}

function ReasoningPart({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Collapsible className="my-2 rounded-lg border bg-background p-2 text-muted-foreground">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-transparent"
        >
          Reasoning
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 whitespace-pre-wrap font-mono text-[0.85em] leading-relaxed">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ImagePart({ image }: { image?: string }) {
  if (!image) return null;
  return <img src={image} alt="" className="my-3 max-h-96 max-w-full rounded-lg" />;
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="flex items-center gap-0.5"
    >
      <ActionBarPrimitive.Copy asChild>
        <Button variant="ghost" size="xs" aria-label="Copy">
          <MessagePrimitive.If copied>Copied</MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>Copy</MessagePrimitive.If>
        </Button>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <Button variant="ghost" size="xs" aria-label="Regenerate">
          Regenerate
        </Button>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
}

function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className="flex items-center gap-1 text-xs"
    >
      <BranchPickerPrimitive.Previous asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Previous branch">
          ←
        </Button>
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Next branch">
          →
        </Button>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

function Composer({
  conversationId,
  authedFetch,
}: {
  conversationId: string;
  authedFetch: AuthedFetch;
}) {
  // conversationId comes from the URL (/c/<cid>) via App → ChatRoom →
  // here. The chat transport's prepareSendMessagesRequest also uses
  // this same id as body.id, so toolbar GET/PUT and /chat hit the
  // same SQLite row.
  return (
    <div className="border-t bg-background">
      <div className="mx-auto w-full max-w-[44rem] px-4 pb-3 pt-3">
        <ComposerPrimitive.Root className="flex flex-col gap-2 rounded-lg border border-input bg-transparent px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
          <ComposerPrimitive.Input asChild>
            <textarea
              placeholder="Send a message…"
              autoFocus
              rows={1}
              className="field-sizing-content min-h-6 max-h-50 w-full resize-none bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
            />
          </ComposerPrimitive.Input>
          <div className="flex items-center gap-2">
            <ComposerOptionsMenu conversationId={conversationId} authedFetch={authedFetch} />
            <ConnectorsMenu conversationId={conversationId} authedFetch={authedFetch} />
            <ComposerPrimitive.Send asChild>
              <Button size="sm" className="ml-auto">
                Send
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </div>
  );
}
