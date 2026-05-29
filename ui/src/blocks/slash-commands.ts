import type { Unstable_SlashCommand } from "@assistant-ui/react";
import type { TFunction } from "i18next";

/**
 * Slash commands exposed via `/` in the composer.
 *
 * Each command's `execute()` dispatches a `CustomEvent` on `window` that
 * other UI components listen for — keeping the slash adapter decoupled
 * from the dropdown internals (`ComposerOptionsMenu`, `ConnectorsMenu`)
 * and the help dialog state (lives in `App.tsx`).
 *
 * - `/clear` → `augchatd:new-thread`
 * - `/model` → `augchatd:open-model-picker`
 * - `/connectors` → `augchatd:open-connectors`
 * - `/help` → `augchatd:open-help`
 *
 * Descriptions are built lazily from `t` so they re-render in the active
 * locale — see [[contract-ui-i18n]].
 */
export function buildSlashCommands(t: TFunction): readonly Unstable_SlashCommand[] {
  return [
    {
      id: "clear",
      description: t("slash.clear"),
      icon: "Plus",
      execute: () => {
        window.dispatchEvent(new CustomEvent("augchatd:new-thread"));
      },
    },
    {
      id: "model",
      description: t("slash.model"),
      icon: "Zap",
      execute: () => {
        window.dispatchEvent(new CustomEvent("augchatd:open-model-picker"));
      },
    },
    {
      id: "connectors",
      description: t("slash.connectors"),
      icon: "Wrench",
      execute: () => {
        window.dispatchEvent(new CustomEvent("augchatd:open-connectors"));
      },
    },
    {
      id: "help",
      description: t("slash.help"),
      icon: "HelpCircle",
      execute: () => {
        window.dispatchEvent(new CustomEvent("augchatd:open-help"));
      },
    },
  ];
}

export function buildSlashCommandList(
  t: TFunction,
): ReadonlyArray<{ id: string; description: string }> {
  return [
    { id: "/clear", description: t("slash.clear") },
    { id: "/model", description: t("slash.model") },
    { id: "/connectors", description: t("slash.connectors") },
    { id: "/help", description: t("help.cheatsheet") },
  ];
}
