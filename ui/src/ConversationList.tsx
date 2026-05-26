import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { AuthedFetch } from "@/lib/authedFetch";

export interface ConversationListItem {
  conversation_id: string;
  title: string | null;
  message_count: number;
  model_id_override: string | null;
  updated_at: string;
}

interface ConversationListProps {
  authedFetch: AuthedFetch;
  currentCid: string;
  refetchKey: number;
  onSelect: (cid: string) => void;
  onNew: () => void;
  onDelete: (cid: string) => void;
}

export function ConversationList({
  authedFetch,
  currentCid,
  refetchKey,
  onSelect,
  onNew,
  onDelete,
}: ConversationListProps) {
  const [conversations, setConversations] = useState<
    ConversationListItem[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const r = await authedFetch("/conversations");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { conversations: ConversationListItem[] };
        if (cancelled) return;
        setConversations(data.conversations ?? []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch, refetchKey, attempt]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Conversas
        </span>
        <Button size="sm" variant="ghost" onClick={onNew}>
          + Nova
        </Button>
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {conversations === null && !error && <LoadingSkeleton />}
        {error && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive">
            <span>Erro ao listar.</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setAttempt((a) => a + 1)}
            >
              Reconectar
            </Button>
          </div>
        )}
        {conversations && conversations.length === 0 && !error && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Nenhuma conversa ainda.
          </div>
        )}
        {conversations &&
          conversations.map((c) => (
            <ConversationRow
              key={c.conversation_id}
              item={c}
              active={c.conversation_id === currentCid}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="h-10 animate-pulse rounded bg-muted/50" />
      <div className="mt-1 h-10 animate-pulse rounded bg-muted/50" />
      <div className="mt-1 h-10 animate-pulse rounded bg-muted/50" />
    </div>
  );
}

function ConversationRow({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: ConversationListItem;
  active: boolean;
  onSelect: (cid: string) => void;
  onDelete: (cid: string) => void;
}) {
  const cid = item.conversation_id;
  return (
    <button
      type="button"
      onClick={() => onSelect(cid)}
      aria-current={active ? "page" : undefined}
      className={
        "group/row mt-0.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors " +
        (active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50")
      }
    >
      <div className="min-w-0 flex-1">
        {item.title ? (
          <div className="truncate text-sm">{item.title}</div>
        ) : (
          <div className="truncate text-sm italic text-muted-foreground">
            Sem título
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">
          {relativeTime(item.updated_at)}
        </div>
      </div>
      <span
        role="button"
        tabIndex={0}
        aria-label="Excluir conversa"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm("Excluir esta conversa?")) onDelete(cid);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            if (window.confirm("Excluir esta conversa?")) onDelete(cid);
          }
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none group-hover/row:opacity-100"
      >
        ✕
      </span>
    </button>
  );
}

/** ISO timestamp → short relative string ("há 5 min", "há 2 d"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const deltaSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (abs < 60) return rtf.format(deltaSec, "second");
  if (abs < 3600) return rtf.format(Math.round(deltaSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(deltaSec / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.round(deltaSec / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.round(deltaSec / 2592000), "month");
  return rtf.format(Math.round(deltaSec / 31536000), "year");
}
