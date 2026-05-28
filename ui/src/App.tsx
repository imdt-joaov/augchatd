import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  // useAui,
  useAuiState,
  useMessage,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
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
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { createAuthedFetch, type AuthedFetch, type RefreshJwt } from "@/lib/authedFetch";
import {
  createHistoryAdapter,
  createThreadListAdapter,
} from "@/lib/threadListAdapter";

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
 *
 * Thread state is owned by assistant-ui's `useRemoteThreadListRuntime`
 * with a custom adapter that maps to augchatd's /conversations REST
 * surface (see lib/threadListAdapter.tsx). The URL `/c/<cid>` is
 * synchronized with the active thread's remoteId.
 */
export default function App() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [jwtReady, setJwtReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // jwtRef is shared by every authed request (chat transport, sidebar
  // adapter, model picker, connector toggle). The handshake-driven
  // refresh updates it in place; setting state would re-render the
  // whole subtree and tear down the chat runtime.
  const jwtRef = useRef<string>("");

  const refreshJwt = useCallback<RefreshJwt>(async () => {
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
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the JWT when the chat backend emits a `data-augchatd-error`
  // (upstream connector 401). The listener inside each assistant
  // message dispatches the window event; here we run the same
  // postMessage handshake the transport uses for JWT-401. In demo this
  // mints a fresh session against the same boot-loaded config (so the
  // expired connector creds come back the same); in production the
  // integrator's parent page re-mints with refreshed creds.
  useEffect(() => {
    const handler = () => {
      requestJwtFromParent()
        .then(({ jwt, theme }) => {
          jwtRef.current = jwt;
          applyTheme(theme);
        })
        .catch(() => {
          /* parent did not reply; user will see the inline warning */
        });
    };
    window.addEventListener("augchatd:upstream-unauthorized", handler);
    return () =>
      window.removeEventListener("augchatd:upstream-unauthorized", handler);
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-destructive">
        augchatd: {error}
      </div>
    );
  }
  if (!health || !jwtReady) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <TooltipProvider>
      <AugchatdRuntime
        authedFetch={authedFetch}
        jwtRef={jwtRef}
        refreshJwt={refreshJwt}
        health={health}
      />
    </TooltipProvider>
  );
}

function AugchatdRuntime({
  authedFetch,
  jwtRef,
  refreshJwt,
  health,
}: {
  authedFetch: AuthedFetch;
  jwtRef: React.MutableRefObject<string>;
  refreshJwt: RefreshJwt;
  health: HealthState;
}) {
  const adapter = useMemo(
    () => createThreadListAdapter(authedFetch),
    [authedFetch],
  );

  // Boot deep-link: if the URL is /c/<cid>, hand it to the runtime as
  // the initial thread. The runtime will call adapter.fetch(<cid>) to
  // resolve metadata; on failure it falls back to a fresh new thread,
  // so a stale or unknown cid in the URL doesn't trap the user.
  const initialThreadId = useMemo(() => {
    const match = /^\/c\/([^/?#]+)/.exec(window.location.pathname);
    return match?.[1];
  }, []);

  const [flushStalled, setFlushStalled] = useState(false);

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useAugchatdChatRuntime({ authedFetch, jwtRef, refreshJwt, setFlushStalled, flushStalled }),
    adapter,
    ...(initialThreadId !== undefined ? { initialThreadId } : {}),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <UrlSync />
      <SidebarProvider defaultOpen className="h-full min-h-0">
        <ThreadListSidebar collapsible="offcanvas" />
        <SidebarInset className="flex min-h-0 flex-col">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger className="-ml-1" />
          </header>
          {health.mode === "demo" && <DemoBanner />}
          <ChatView authedFetch={authedFetch} flushStalled={flushStalled} />
        </SidebarInset>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Per-thread chat runtime hook, invoked by `useRemoteThreadListRuntime`
 * once per mounted thread. Reads the active thread's `remoteId` (our
 * augchatd `conversation_id`) from the outer adapter's state and hands
 * it to `AssistantChatTransport` as `body.id`.
 *
 * On mount, it eagerly calls `aui.threadListItem().initialize()` so
 * fresh local threads get a server-minted cid before the Composer
 * activates. For threads loaded via `adapter.list()`, `initialize()`
 * is a no-op (their `remoteId` is already populated).
 */
function useAugchatdChatRuntime({
  authedFetch,
  jwtRef,
  refreshJwt,
  setFlushStalled,
  flushStalled,
}: {
  authedFetch: AuthedFetch;
  jwtRef: React.MutableRefObject<string>;
  refreshJwt: RefreshJwt;
  setFlushStalled: React.Dispatch<React.SetStateAction<boolean>>;
  flushStalled: boolean;
}) {
  // const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);

  const cidRef = useRef<string | undefined>(remoteId ?? undefined);
  useEffect(() => {
    cidRef.current = remoteId ?? undefined;
  }, [remoteId]);

  // useEffect(() => {
  //   aui.threadListItem().initialize().catch(() => {
  //     /* errors surface via the failed POST in the network log */
  //   });
  // }, [aui]);

  const history = useMemo(
    () => createHistoryAdapter(authedFetch, cidRef),
    [authedFetch],
  );

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/chat",
        headers: () => ({ Authorization: `Bearer ${jwtRef.current}` }),
        fetch: async (input, init) => {
          const r = await fetch(input, init);
          // 503 + X-Augchatd-Reason: flush-stalled — the session has
          // gone read-only because cold-storage flush stalled past
          // threshold. Surface a banner; the flag clears when a flush
          // eventually succeeds (next successful chat is preceded by a
          // 200 here, which the success-path clears).
          if (
            r.status === 503 &&
            r.headers.get("X-Augchatd-Reason") === "flush-stalled"
          ) {
            setFlushStalled(true);
            return r;
          }
          if (r.status !== 401) {
            if (flushStalled && r.ok) setFlushStalled(false);
            return r;
          }
          if (r.status !== 401) return r;
          try {
            const { jwt } = await refreshJwt();
            jwtRef.current = jwt;
          } catch {
            return r;
          }
          const retriedHeaders = new Headers(init?.headers);
          retriedHeaders.set("Authorization", `Bearer ${jwtRef.current}`);
          const retry = await fetch(input, { ...init, headers: retriedHeaders });
          if (flushStalled && retry.ok) setFlushStalled(false);
          return retry;
        },
        // Override `body.id` to use OUR conversation_id (the active
        // thread's remoteId from the outer RemoteThreadList adapter)
        // instead of the assistant-ui-internal threadListItem.id.
        // assistant-ui's id stays client-local; the server sees only
        // our cid, which is what the SQLite row keys on.
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: { id: cidRef.current, messages, trigger, messageId },
        }),
      }),
    [jwtRef, refreshJwt],
  );

  return useChatRuntime({ transport, adapters: { history } });
}

/**
 * Mirrors the active thread's `remoteId` into the URL (`/c/<cid>`) and
 * forwards the path to the parent frame via postMessage. Replaces the
 * `setIframeRoute` calls that used to live alongside POST /conversations
 * in the old App boot.
 */
function UrlSync() {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  useEffect(() => {
    if (!remoteId) return;
    setIframeRoute(`/c/${remoteId}`);
  }, [remoteId]);
  return null;
}

function DemoBanner() {
  return (
    <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-[13px] font-medium tracking-wide text-destructive">
      Demo session — not authenticated
    </div>
  );
}

/** Update the iframe's route and notify the parent so it can mirror the path. */
function setIframeRoute(path: string): void {
  window.history.replaceState(null, "", path);
  window.parent.postMessage({ type: "augchatd:route", path }, getParentOrigin());
}

/**
 * Parent origin used for postMessage targetOrigin and for filtering inbound
 * messages in the handshake. Read once from `?parent_origin=` on the iframe
 * URL (the integrator sets this when embedding); if absent, falls back to
 * `document.referrer`'s origin with a one-time console warning — the
 * degraded mode is retro-compatible with embedders that haven't been
 * updated yet, but the strict path is the query-param one.
 *
 * Returns the empty string if both sources are missing, in which case
 * postMessage will throw — which is the right outcome (no silent send).
 */
let cachedParentOrigin: string | null = null;
function getParentOrigin(): string {
  if (cachedParentOrigin !== null) return cachedParentOrigin;
  cachedParentOrigin = resolveParentOrigin();
  return cachedParentOrigin;
}
function resolveParentOrigin(): string {
  const fromQuery = new URLSearchParams(window.location.search).get(
    "parent_origin",
  );
  if (fromQuery) {
    try {
      const u = new URL(fromQuery);
      // URL() accepts "https://x.com/path" — we only want the origin.
      return u.origin;
    } catch {
      console.warn(
        `augchatd: ?parent_origin=${JSON.stringify(fromQuery)} is not a valid URL; ` +
          `falling back to document.referrer. Postmessage handshake will be permissive.`,
      );
    }
  }
  const ref = document.referrer;
  if (ref) {
    try {
      const origin = new URL(ref).origin;
      console.warn(
        `augchatd: ?parent_origin= missing on iframe URL; using document.referrer (${origin}). ` +
          `For strict origin checking, embed with src="…?parent_origin=<parent-origin>".`,
      );
      return origin;
    } catch {
      // referrer was non-empty but unparseable; fall through
    }
  }
  console.warn(
    `augchatd: no parent_origin and no document.referrer — postMessage handshake cannot run.`,
  );
  return "";
}

/**
 * iframe ↔ parent handshake (contract-ui-handshake). Re-callable — each
 * call requests a fresh JWT, so 401 recovery uses the same code path.
 */
function requestJwtFromParent(
  timeoutMs = 10000,
): Promise<{ jwt: string; theme?: "light" | "dark" }> {
  return new Promise((resolve, reject) => {
    const parentOrigin = getParentOrigin();
    const handler = (e: MessageEvent) => {
      if (parentOrigin && e.origin !== parentOrigin) return;
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
    window.parent.postMessage({ type: "augchatd:ready" }, parentOrigin);
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
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function ChatView({ authedFetch, flushStalled }: { authedFetch: AuthedFetch; flushStalled: boolean }) {
  return (
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
      {flushStalled ? (
          <FlushStalledBanner />
        ) : (
          <Composer authedFetch={authedFetch} />
        )}
    </ThreadPrimitive.Root>
  );
}

/**
 * Banner shown when the chat transport observes a 503 + `X-Augchatd-Reason:
 * flush-stalled` — see contract-storage-durability and contract-session-chat
 * §Observable outcomes. Replaces the composer entirely so the user cannot
 * try to send while the session is read-only; the flag clears
 * automatically when the next chat call returns 200 (which means the
 * background retry chain landed a successful flush).
 */
function FlushStalledBanner() {
  return (
    <div className="border-t border-warn-border bg-warn-bg">
      <div className="mx-auto flex w-full max-w-thread items-start gap-3 px-4 py-3 text-warn-fg">
        <span aria-hidden className="text-lg leading-none">⚠</span>
        <div className="flex-1 text-sm">
          <div className="font-semibold">
            Service temporarily read-only — your messages are preserved.
          </div>
          <div className="mt-1 text-xs opacity-90">
            Cold-storage flush is failing; new turns are paused until durability
            is restored. The chat resumes automatically on the next successful
            flush.
          </div>
        </div>
      </div>
    </div>
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
        <UpstreamAuthListener />
      </div>
      <div className="mt-1 flex items-center gap-1 text-muted-foreground">
        <AssistantActionBar />
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Per-assistant-message side-channel listener for the
 * `data-augchatd-error` UI part the chat backend emits on upstream
 * connector 401. On detection, dispatches a window-level event;
 * `ChatRoom` listens to it and reruns the JWT handshake (which in
 * production re-mints with refreshed connector credentials). Renders
 * nothing — the visible warning to the user is the inline text-delta
 * the chat backend emits alongside the data part. See
 * spec/src/behavior/contracts/jwt-refresh.md.
 */
function UpstreamAuthListener() {
  const hasUpstreamAuthError = useMessage((s) => {
    // assistant-ui normalizes the AI SDK's `data-<name>` parts to
    // `{type: "data", name: "<name>", data: ...}` in the message
    // content. We watch for `name === "augchatd-error"` once it appears
    // anywhere in the message — the chat backend emits exactly one
    // such part per turn, after the stream settles.
    const content = (s as { content?: readonly unknown[] }).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "data" &&
        (p as { name?: unknown }).name === "augchatd-error",
    );
  });
  const triggeredRef = useRef(false);
  useEffect(() => {
    if (!hasUpstreamAuthError || triggeredRef.current) return;
    triggeredRef.current = true;
    window.dispatchEvent(new CustomEvent("augchatd:upstream-unauthorized"));
  }, [hasUpstreamAuthError]);
  return null;
}

/**
 * Per-assistant-message provenance chip. Reads the model_id stamped by
 * the chat backend's `messageMetadata` callback (chat.ts) via
 * `useMessage` — surfaces a small "Bot icon + gpt-5-mini" label so a user who
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
          <Bot className="size-3" aria-hidden />
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
          <ChevronLeft className="size-3.5" />
        </Button>
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Next branch">
          <ChevronRight className="size-3.5" />
        </Button>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

function Composer({ authedFetch }: { authedFetch: AuthedFetch }) {
  // conversationId comes from the active thread's remoteId (our cid,
  // populated by adapter.initialize() / adapter.list()). The chat
  // transport's prepareSendMessagesRequest also uses this same id as
  // body.id, so toolbar GET/PUT and /chat hit the same SQLite row.
  // While remoteId is still resolving (rare — eager initialize in
  // useAugchatdChatRuntime makes this ~1 tick), the per-conversation
  // menus stay hidden so they don't fire PUTs against undefined.
  const conversationId = useAuiState((s) => s.threadListItem.remoteId);
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
            {conversationId && (
              <>
                <ComposerOptionsMenu conversationId={conversationId} authedFetch={authedFetch} />
                <ConnectorsMenu conversationId={conversationId} authedFetch={authedFetch} />
              </>
            )}
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
