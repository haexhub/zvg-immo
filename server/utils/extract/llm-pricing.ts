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
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (claude-proxy) — https://www.anthropic.com/pricing
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
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
  const inputCost = ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion
  return inputCost + outputCost
}
