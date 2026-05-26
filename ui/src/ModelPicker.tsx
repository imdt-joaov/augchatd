import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-conversation LLM model picker (composer-toolbar variant).
 *
 * Backed by:
 *   GET /session/models                        → list + current session default
 *   PUT /conversations/:cid/model { model_id } → set per-conversation override
 *
 * Initial label shows the session default returned by GET /session/models.
 * After a successful PUT the label updates locally. The override persists
 * server-side; on a hard reload the picker resets to the session default
 * but the chat continues to use whatever was last PUT (known UI-only
 * limitation; see conversation-registry persistence note).
 */

interface ModelInfo {
  id: string;
  display_name: string;
  provider: string;
}

interface ModelsResponse {
  models: ModelInfo[];
  current_model_id: string;
  provider: string;
  cached: boolean;
}

type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function ModelPicker({
  conversationId,
  authedFetch,
}: {
  conversationId: string;
  authedFetch: AuthedFetch;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await authedFetch("/session/models");
      if (!r.ok) throw new Error(`GET HTTP ${r.status}`);
      const j = (await r.json()) as ModelsResponse;
      setModels(j.models);
      setSelected((prev) => prev ?? j.current_model_id);
      setProvider(j.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authedFetch]);

  // Eagerly fetch on mount so the button label can show the current model.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = async (model_id: string) => {
    if (model_id === selected) {
      setOpen(false);
      return;
    }
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
      setSelected(model_id);
      setOpen(false);
      // Tell sibling controls (e.g. ReasoningToggle) the active model
      // changed so they can show/hide based on the new model's
      // capabilities. Same-tab only; CustomEvent on window is sufficient
      // — there is no cross-tab story for a single demo conversation.
      window.dispatchEvent(
        new CustomEvent("augchatd:current-model-changed", { detail: { model_id } }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="
          inline-flex items-center gap-1 rounded-md border border-border
          bg-bg-soft px-2.5 py-1 text-[12px] text-fg-base
          hover:bg-bg-mid disabled:opacity-50
        "
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span aria-hidden>⚡</span>
        <span>{selected ?? "Model…"}</span>
      </button>
      {open && (
        <div
          className="
            absolute bottom-full left-0 z-10 mb-1 max-h-80 w-72 overflow-y-auto
            rounded-lg border border-border bg-bg-base p-2
            text-left text-fg-base shadow-lg
          "
        >
          <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Model (this conversation){provider ? ` · ${provider}` : ""}
          </div>
          {error && (
            <div className="mb-2 px-1 text-[12px] text-warn-fg">Error: {error}</div>
          )}
          {!models && !error && (
            <div className="px-1 py-2 text-[13px] text-fg-muted">Loading…</div>
          )}
          {models && models.length === 0 && (
            <div className="px-1 py-2 text-[13px] text-fg-muted">
              No models returned.
            </div>
          )}
          {models && models.length > 0 && (
            <ul className="flex flex-col">
              {models.map((m) => {
                const isSelected = m.id === selected;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => void pick(m.id)}
                      disabled={busy}
                      className={`
                        flex w-full items-center justify-between gap-2 rounded
                        px-2 py-1.5 text-left text-[13px]
                        hover:bg-bg-mid disabled:opacity-50
                        ${isSelected ? "bg-bg-mid font-semibold" : ""}
                      `}
                    >
                      <span className="truncate">{m.display_name}</span>
                      {isSelected && <span aria-hidden>✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
