import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
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
    <>
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-data-[collapsible=icon]:hidden">
            Conversas
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onNew}
            aria-label="Nova conversa"
            className="ml-auto"
          >
            <Plus className="size-4" />
            <span className="group-data-[collapsible=icon]:hidden">Nova</span>
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {conversations === null && !error && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        {error && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive group-data-[collapsible=icon]:hidden">
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
          <div className="px-3 py-6 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            Nenhuma conversa ainda.
          </div>
        )}
        {conversations && conversations.length > 0 && (
          <SidebarMenu>
            {conversations.map((c) => (
              <ConversationItem
                key={c.conversation_id}
                item={c}
                active={c.conversation_id === currentCid}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarContent>
    </>
  );
}

function ConversationItem({
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
  const label = item.title ?? "Sem título";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        {...(active ? { isActive: true } : {})}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(cid)}
        tooltip={label}
        className="h-auto items-start py-2"
      >
        <div className="flex min-w-0 flex-col">
          <span
            className={
              item.title
                ? "truncate"
                : "truncate italic text-muted-foreground"
            }
          >
            {label}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {relativeTime(item.updated_at)}
          </span>
        </div>
      </SidebarMenuButton>
      <SidebarMenuAction
        showOnHover
        aria-label="Excluir conversa"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm("Excluir esta conversa?")) onDelete(cid);
        }}
      >
        <X />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

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
