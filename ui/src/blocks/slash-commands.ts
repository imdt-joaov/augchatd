import type { Unstable_SlashCommand } from "@assistant-ui/react";

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
 */
export const SLASH_COMMANDS: readonly Unstable_SlashCommand[] = [
  {
    id: "clear",
    description: "Start a new conversation",
    icon: "Plus",
    execute: () => {
      window.dispatchEvent(new CustomEvent("augchatd:new-thread"));
    },
  },
  {
    id: "model",
    description: "Switch the AI model",
    icon: "Zap",
    execute: () => {
      window.dispatchEvent(new CustomEvent("augchatd:open-model-picker"));
    },
  },
  {
    id: "connectors",
    description: "Toggle connectors",
    icon: "Wrench",
    execute: () => {
      window.dispatchEvent(new CustomEvent("augchatd:open-connectors"));
    },
  },
  {
    id: "help",
    description: "Show available slash commands",
    icon: "HelpCircle",
    execute: () => {
      window.dispatchEvent(new CustomEvent("augchatd:open-help"));
    },
  },
];

export const SLASH_COMMAND_LIST: ReadonlyArray<{
  id: string;
  description: string;
}> = [
  { id: "/clear", description: "Start a new conversation" },
  { id: "/model", description: "Switch the AI model" },
  { id: "/connectors", description: "Toggle connectors" },
  { id: "/help", description: "Show this cheatsheet" },
];
