import { useCallback, useEffect, useState } from "react";

/**
 * Per-conversation reasoning toggle (composer-toolbar variant), backed by
 * contract-reasoning-toggle:
 *
 *   GET /conversations/:cid/reasoning            → { enabled: boolean }
 *   PUT /conversations/:cid/reasoning            → 204
 *   GET /session/models                          → models[].supports_reasoning
 *
 * The button hides entirely when the active model is not reasoning-capable
 * — there is nothing to toggle. It listens to the
 * `augchatd:current-model-changed` window event so a model switch in the
 * sibling ModelPicker can show/hide the button without a remount.
 *
 * Known limitation (shared with ModelPicker): a hard reload resets the
 * picker's local notion of the current model to the session default, even
 * if the conversation has an override. The toggle inherits the same
 * limitation; tracked alongside the picker's hydration follow-up.
 */

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

export function ReasoningToggle({
  conversationId,
  authedFetch,
}: {
  conversationId: string;
  authedFetch: AuthedFetch;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [supportMap, setSupportMap] = useState<Map<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    try {
      const r = await authedFetch("/session/models");
      if (!r.ok) throw new Error(`GET /session/models HTTP ${r.status}`);
      const j = (await r.json()) as ModelsResponse;
      const map = new Map<string, boolean>();
      for (const m of j.models) map.set(m.id, m.supports_reasoning);
      setSupportMap(map);
      setCurrentModelId((prev) => prev ?? j.current_model_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authedFetch]);

  const loadState = useCallback(async () => {
    try {
      const r = await authedFetch(
        `/conversations/${encodeURIComponent(conversationId)}/reasoning`,
      );
      if (!r.ok) throw new Error(`GET reasoning HTTP ${r.status}`);
      const j = (await r.json()) as { enabled: boolean };
      setEnabled(j.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conversationId, authedFetch]);

  useEffect(() => {
    void loadModels();
    void loadState();
  }, [loadModels, loadState]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ model_id?: string }>).detail;
      if (detail && typeof detail.model_id === "string") {
        setCurrentModelId(detail.model_id);
      }
    };
    window.addEventListener("augchatd:current-model-changed", onChanged);
    return () =>
      window.removeEventListener("augchatd:current-model-changed", onChanged);
  }, []);

  const supports =
    currentModelId !== null && supportMap !== null
      ? (supportMap.get(currentModelId) ?? false)
      : null;

  // Hide entirely until we know the model AND the model is reasoning-capable.
  // Per the user-confirmed UX: no toggle for non-reasoning models.
  if (supports !== true) return null;
  if (enabled === null) return null;

  const tooltip = enabledTooltip(currentModelId);

  const flip = async () => {
    if (busy) return;
    const next = !enabled;
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
      setEnabled(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void flip()}
      disabled={busy}
      title={error ? `Error: ${error}` : tooltip}
      aria-pressed={enabled}
      className={`
        inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px]
        hover:bg-bg-mid disabled:opacity-50
        ${enabled
          ? "border-accent bg-bg-soft text-fg-base"
          : "border-border bg-bg-soft text-fg-muted"}
      `}
    >
      <span aria-hidden>🧠</span>
      <span>Reasoning: {enabled ? "on" : "off"}</span>
    </button>
  );
}

function enabledTooltip(modelId: string | null): string {
  if (modelId && /^(o[1-9]|gpt-5)/.test(modelId)) {
    return (
      "Toggle whether the model's reasoning summary is streamed and shown. " +
      "Note: gpt-5 / o-series models always reason internally; turning this off " +
      "only hides the summary and does NOT reduce reasoning_tokens cost."
    );
  }
  return "Toggle whether the model's extended-thinking output is streamed and shown.";
}
