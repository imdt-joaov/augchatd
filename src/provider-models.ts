/**
 * List the chat-capable models for a given provider, hitting the
 * provider's own list-models endpoint with the session's key.
 *
 * Returned shape is provider-agnostic so the UI doesn't need to
 * special-case. Cached per-session at the call-site.
 */

export interface ProviderModel {
  /** Canonical id used when calling the provider (also what augchatd stores). */
  id: string;
  /** Friendly label for the UI (may equal id when the provider has no display name). */
  display_name: string;
  provider: string;
  /**
   * ISO 8601 UTC timestamp of when the provider published this model.
   * Normalized from OpenAI's `created` (unix seconds) and Anthropic's
   * `created_at` (RFC 3339). The bundled UI sorts by this field to
   * surface the newest models first in the picker.
   */
  created_at: string;
}

export async function listProviderModels(
  provider: string,
  apiKey: string,
): Promise<ProviderModel[]> {
  switch (provider) {
    case "openai":
      return listOpenAIModels(apiKey);
    case "anthropic":
      return listAnthropicModels(apiKey);
    default:
      throw new Error(`Unsupported provider for model listing: ${provider}`);
  }
}

interface OpenAIListResponse {
  data: Array<{ id: string; owned_by?: string; created: number }>;
}

async function listOpenAIModels(apiKey: string): Promise<ProviderModel[]> {
  const r = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) {
    throw new Error(`openai list models: HTTP ${r.status}`);
  }
  const j = (await r.json()) as OpenAIListResponse;
  // OpenAI's /v1/models returns ~50 entries including legacy generations,
  // embeddings, image-gen, audio (tts/transcribe), code-tuned variants,
  // and special-purpose endpoints. The picker is a per-conversation
  // model override for chat-agentic use, so we curate aggressively:
  //
  //   ALLOW gpt-5*, gpt-4o*, gpt-4.1*, chatgpt-* prefix; o[1-9]* reasoning models
  //   DROP  date-stamped snapshots (-YYYY-MM-DD)
  //   DROP  audio (-audio/-tts/-transcribe), images (gpt-image-*/chatgpt-image-*),
  //         realtime/search-preview/search-api/deep-research,
  //         code-tuned (-codex) — all not what augchatd's chat lane needs
  //   DROP  legacy: gpt-3.5*, plain gpt-4 / gpt-4-0613 / gpt-4-turbo*
  //
  // Operators who need a dropped variant can still PUT it via
  // /conversations/:cid/model — the validation reads from this cache, so
  // the user has to first call `GET /session/models` after editing the
  // filter, but the override path itself isn't blocked.
  const chatRe = /^(gpt-|chatgpt-|o[1-9])/;
  const dateRe = /-\d{4}-\d{2}-\d{2}$/;
  const specialRe =
    /-audio|-realtime|-search-preview|-search-api|-transcribe|-tts|-deep-research|-codex/;
  const imageRe = /^(chatgpt|gpt)-image/;
  const legacyRe = /^gpt-3\.5|^gpt-4($|-0613|-turbo)/;
  return j.data
    .filter((m) => chatRe.test(m.id))
    .filter((m) => !dateRe.test(m.id))
    .filter((m) => !specialRe.test(m.id))
    .filter((m) => !imageRe.test(m.id))
    .filter((m) => !legacyRe.test(m.id))
    .map((m) => ({
      id: m.id,
      display_name: m.id,
      provider: "openai",
      created_at: new Date(m.created * 1000).toISOString(),
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

interface AnthropicListResponse {
  data: Array<{
    id: string;
    display_name?: string;
    type?: string;
    created_at: string;
  }>;
}

async function listAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!r.ok) {
    throw new Error(`anthropic list models: HTTP ${r.status}`);
  }
  const j = (await r.json()) as AnthropicListResponse;
  return j.data
    .map((m) => ({
      id: m.id,
      display_name: m.display_name ?? m.id,
      provider: "anthropic",
      created_at: m.created_at,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
