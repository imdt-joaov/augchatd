import type { UIMessage } from "ai";

/**
 * Folds a user message's `metadata.custom.quote.text` (set by the
 * bundled UI's selection toolbar → `ComposerPrimitive.QuoteText` flow)
 * into a leading markdown blockquote `text` part so the LLM actually
 * sees the quoted excerpt.
 *
 * `convertToModelMessages` (from `ai`) drops `metadata` when building
 * the wire-level message list — without this transform the quote
 * disappears between the browser and the model. The transform is
 * idempotent: if the leading part already matches the would-be
 * blockquote, the message is returned unchanged (regenerate/re-stream
 * paths re-run this same fold safely).
 *
 * Mirrors `@assistant-ui/react-ai-sdk`'s `injectQuoteContext` so the
 * backend doesn't have to take a hard dependency on a React-shaped
 * package just to read a metadata field.
 */
export function injectQuoteContext(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    const text = getQuoteText(msg.metadata);
    if (!text) return msg;
    const blockquote = text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    const leading = `${blockquote}\n\n`;
    const firstPart = msg.parts?.[0];
    if (firstPart?.type === "text" && firstPart.text === leading) return msg;
    return {
      ...msg,
      parts: [{ type: "text", text: leading }, ...(msg.parts ?? [])],
    };
  });
}

function getQuoteText(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const custom = (metadata as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object") return undefined;
  const quote = (custom as { quote?: unknown }).quote;
  if (!quote || typeof quote !== "object") return undefined;
  const text = (quote as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}
