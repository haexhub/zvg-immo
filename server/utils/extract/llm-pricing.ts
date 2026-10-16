// Static USD-per-million-token pricing for cost estimation (llm-usage.ts).
// Deliberately a plain lookup table, not a live pricing API call — providers
// don't offer one, and estimation only needs to be roughly current, not
// exact. Prices below are approximate list prices at the time this was
// written and WILL drift — re-check against each provider's pricing page
// when adding a model or when numbers look stale. A model missing here
// resolves to `null` cost (see estimateCostUsd), never a guessed 0, so an
// unpriced model is visibly "unbepreist" in the settings UI instead of
// silently undercounting spend.
//
// Keyed by the exact `model` string stored on LlmConfig — OpenRouter's
// `:batch`-suffixed catalog ids (see openai-compatible.ts's syncModel) price
// the same as their sync counterpart, so the suffix is stripped before
// lookup rather than duplicated as a second table entry.

export interface ModelPricing {
  /** USD per 1,000,000 input/prompt tokens. */
  inputPerMillion: number
  /** USD per 1,000,000 output/completion tokens. */
  outputPerMillion: number
  longPrompt?: {
    thresholdInputTokens: number
    inputPerMillion: number
    outputPerMillion: number
  }
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (claude-proxy) — https://www.anthropic.com/pricing. Mirrors
  // haex-claude-proxy's advertised model list (its /v1/models), including
  // the dated Haiku 4.5 id the proxy serves.
  'claude-fable-5-1': { inputPerMillion: 10, outputPerMillion: 50 },
  'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50 },
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10 },
  // SettingsLlmProfilesCard.vue's claude-proxy default template.
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  // claude-haiku-5-5: up to 100K prompt tokens at $0.10 / $0.50;
  // above 100K at $0.50 / $2.50.
  'claude-haiku-5-5': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    longPrompt: { thresholdInputTokens: 100_000, inputPerMillion: 0.5, outputPerMillion: 2.5 },
  },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
  // Gemini (gemini-native) — https://ai.google.dev/gemini-api/docs/pricing
  'gemini-flash-latest': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
}

function stripBatchSuffix(model: string): string {
  return model.replace(/:batch$/, '')
}

/** Null when the model isn't in MODEL_PRICING — callers must treat that as
 *  "unknown", not "free". */
export function lookupModelPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[stripBatchSuffix(model)] ?? null
}

/** Null when the model is unpriced, or when both token counts are null
 *  (nothing to estimate from — a request that never got a usable response). */
export function estimateCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const pricing = lookupModelPricing(model)
  if (!pricing) return null
  if (inputTokens == null && outputTokens == null) return null
  const tier = pricing.longPrompt && (inputTokens ?? 0) > pricing.longPrompt.thresholdInputTokens
    ? pricing.longPrompt
    : pricing
  const inputCost = ((inputTokens ?? 0) / 1_000_000) * tier.inputPerMillion
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * tier.outputPerMillion
  return inputCost + outputCost
}

// The batch APIs of every priced provider (Anthropic Message Batches, Gemini
// Batch) bill half the sync list price; without this, batch rows showed about
// twice their real cost.
const BATCH_PRICE_FACTOR = 0.5

/** Shared by every writer of a per-call cost (llm-usage.ts's llm_usage_events
 *  log, auction-details.ts's per-version llmCostUsd): prefer the provider's
 *  own billed amount when the request asked for it (see openai-compatible.ts's
 *  `usage: { include: true }` for OpenRouter), falling back to the static
 *  price table otherwise. */
export function resolveCostUsd(
  model: string,
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd?: number | null } | null,
  executionMode: 'sync' | 'batch' = 'sync',
): number | null {
  if (usage?.costUsd != null) return usage.costUsd
  const estimate = estimateCostUsd(model, usage?.inputTokens ?? null, usage?.outputTokens ?? null)
  return estimate != null && executionMode === 'batch' ? estimate * BATCH_PRICE_FACTOR : estimate
}
