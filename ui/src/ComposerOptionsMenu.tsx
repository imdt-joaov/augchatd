import { useCallback, useEffect, useState } from "react";
import { Brain, ChevronDown, Scale, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";

interface ModelInfo {
  id: string;
  display_name: string;
  provider: string;
  supports_reasoning: boolean;
}

interface ModelsResponse {
  models: ModelInfo[];
  current_model_id: string;
  provider: string;
  cached: boolean;
}

type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function ComposerOptionsMenu({
  conversationId,
  authedFetch,
}: {
  conversationId: string;
  authedFetch: AuthedFetch;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [reasoningEnabled, setReasoningEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open state — externally controllable via `augchatd:open-model-picker`
  // (fired by the `/model` slash command).
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("augchatd:open-model-picker", handler);
    return () => window.removeEventListener("augchatd:open-model-picker", handler);
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const r = await authedFetch("/session/models");
      if (!r.ok) throw new Error(`GET /session/models HTTP ${r.status}`);
      const j = (await r.json()) as ModelsResponse;
      setModels(j.models);
      setCurrentModelId((prev) => prev ?? j.current_model_id);
      setProvider(j.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authedFetch]);

  const loadReasoning = useCallback(async () => {
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/reasoning`,
      );
      if (!r.ok) throw new Error(`GET reasoning HTTP ${r.status}`);
      const j = (await r.json()) as { enabled: boolean };
      setReasoningEnabled(j.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conversationId, authedFetch]);

  useEffect(() => {
    void loadModels();
    void loadReasoning();
  }, [loadModels, loadReasoning]);

  const pickModel = async (model_id: string) => {
    if (model_id === currentModelId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/model`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id }),
        },
      );
      if (r.status !== 204) {
        const text = await r.text().catch(() => "");
        throw new Error(`PUT HTTP ${r.status}${text ? ` — ${text.slice(0, 120)}` : ""}`);
      }
      setCurrentModelId(model_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const flipReasoning = async () => {
    if (busy || reasoningEnabled === null) return;
    const next = !reasoningEnabled;
    setBusy(true);
    setError(null);
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/reasoning`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      if (r.status !== 204) {
        const text = await r.text().catch(() => "");
        throw new Error(`PUT HTTP ${r.status}${text ? ` — ${text.slice(0, 120)}` : ""}`);
      }
      setReasoningEnabled(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const currentModel = models?.find((m) => m.id === currentModelId) ?? null;
  const supportsReasoning = currentModel?.supports_reasoning ?? false;
  const reasoningTooltip = reasoningTooltipFor(currentModelId);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Composer options">
          <Zap className="size-3.5" aria-hidden />
          <span className="max-w-[160px] truncate">
            {currentModel?.display_name ?? currentModelId ?? "Model…"}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Scale className="mr-2 size-4" aria-hidden />
            <span>Model</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72 max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Model (this conversation){provider ? ` · ${provider}` : ""}
            </DropdownMenuLabel>
            {!models && !error && (
              <div className="px-2 py-2 text-[13px] text-muted-foreground">Loading…</div>
            )}
            {models && models.length === 0 && (
              <div className="px-2 py-2 text-[13px] text-muted-foreground">
                No models returned.
              </div>
            )}
            {models?.map((m) => {
              const isSelected = m.id === currentModelId;
              return (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={isSelected}
                  disabled={busy}
                  onSelect={(e) => {
                    e.preventDefault();
                    void pickModel(m.id);
                  }}
                >
                  <span className="truncate">{m.display_name}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {supportsReasoning && reasoningEnabled !== null && (
          <DropdownMenuItem
            title={error ? `Error: ${error}` : reasoningTooltip}
            onSelect={(e) => {
              e.preventDefault();
              void flipReasoning();
            }}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <Brain className="size-4" aria-hidden />
              <span>Reasoning</span>
            </span>
            <Switch checked={reasoningEnabled} aria-label="Toggle reasoning" />
          </DropdownMenuItem>
        )}

        {error && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-[12px] text-destructive">Error: {error}</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function reasoningTooltipFor(modelId: string | null): string {
  if (modelId && /^(o[1-9]|gpt-5)/.test(modelId)) {
    return (
      "Toggle whether the model's reasoning summary is streamed and shown. " +
      "Note: gpt-5 / o-series models always reason internally; turning this off " +
      "only hides the summary and does NOT reduce reasoning_tokens cost."
    );
  }
  return "Toggle whether the model's extended-thinking output is streamed and shown.";
}
