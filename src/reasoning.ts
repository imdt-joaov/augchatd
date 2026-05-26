/**
 * Whether a given (provider, modelId) is a reasoning model — i.e. one
 * for which augchatd asks the provider to surface internal reasoning
 * (OpenAI's `reasoningSummary`, Anthropic's `thinking`).
 *
 * Single source of truth for two consumers:
 *   - src/routes/chat.ts — decides whether to set providerOptions
 *   - src/routes/models.ts — stamps `supports_reasoning` on each model in
 *     the `GET /session/models` response so the UI can hide the toggle
 *     for models that don't support reasoning at all.
 *
 * The regex matches the catalog filter in provider-models.ts.
 */
export function supportsReasoning(provider: string, modelId: string): boolean {
  if (provider === "openai") return /^(o[1-9]|gpt-5)/.test(modelId);
  if (provider === "anthropic") return /opus|sonnet/.test(modelId);
  return false;
}
