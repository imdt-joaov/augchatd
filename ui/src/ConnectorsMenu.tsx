import { useCallback, useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";

interface ConnectorListItem {
  descriptive_id: string;
  name: string;
  type: "mcp" | "rag";
  active: boolean;
}

type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function ConnectorsMenu({
  conversationId,
  authedFetch,
}: {
  conversationId: string;
  authedFetch: AuthedFetch;
}) {
  const [items, setItems] = useState<ConnectorListItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/connectors`,
      );
      if (!r.ok) throw new Error(`GET HTTP ${r.status}`);
      setItems((await r.json()) as ConnectorListItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conversationId, authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (descriptive_id: string, next: boolean) => {
    setBusy(descriptive_id);
    setError(null);
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/connectors/${encodeURIComponent(descriptive_id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: next }),
        },
      );
      if (r.status !== 204) throw new Error(`PUT HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const activeCount = items?.filter((i) => i.active).length ?? 0;
  const totalCount = items?.length ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Toggle connectors">
          <Wrench className="size-3.5" aria-hidden />
          <span>Tools{items ? ` ${activeCount}/${totalCount}` : ""}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connectors (this conversation)
        </DropdownMenuLabel>
        {error && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-[12px] text-destructive">Error: {error}</div>
          </>
        )}
        {!items && !error && (
          <div className="px-2 py-2 text-[13px] text-muted-foreground">Loading…</div>
        )}
        {items && items.length === 0 && (
          <div className="px-2 py-2 text-[13px] text-muted-foreground">
            No connectors in scope.
          </div>
        )}
        {items?.map((c) => (
          <DropdownMenuItem
            key={c.descriptive_id}
            disabled={busy === c.descriptive_id}
            onSelect={(e) => {
              e.preventDefault();
              void toggle(c.descriptive_id, !c.active);
            }}
            className="flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{c.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {c.type} · {c.descriptive_id}
              </div>
            </div>
            <Switch
              checked={c.active}
              aria-label={`Toggle ${c.name}`}
              tabIndex={-1}
              className="pointer-events-none mt-0.5"
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
