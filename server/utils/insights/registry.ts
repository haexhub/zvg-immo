// Registry of on-demand per-auction LLM insight cards (Family A: keyed by
// extraction content-hash, user-triggered, German-generated text). One
// registry entry replaces what used to be a hand-rolled cache table +
// endpoint + settings wiring per feature (see translation.post.ts/
// summary.post.ts before this framework). Adding a new insight means adding
// one file here, not touching the endpoint, cache, or settings plumbing.

import type { Auction } from '~/types/auction'
import { usageIdeasInsight } from './usage-ideas'

export interface InsightDefinition<T> {
  /** Stable id, used as the DB key, the API route segment and the LLM
   *  max-tokens settings kind — e.g. 'usage-ideas', later
   *  'renovation-cost-estimate', 'utility-connections'. */
  id: string
  maxTokensDefault: number
  rateLimitPerHourPerIp: number
  /** Bumped whenever the prompt/schema changes meaningfully — salts the
   *  content hash so a wording tweak invalidates old cache entries without
   *  needing a manual cache-bust. */
  promptVersion: number
  buildContentHashInput(auction: Auction): Record<string, unknown>
  buildPrompt(auction: Auction): { systemPrompt: string; userText: string }
  /** Passed as ExtractionRequest['schema'] to ExtractionProvider.extract(). */
  schema: Record<string, unknown>
  /** Validates/trims/dedupes the raw LLM output. Returning null means the
   *  generation failed/was unusable — the caller must not cache a null
   *  result (see insight/[insightId].post.ts). */
  clamp(raw: unknown): T | null
}

export const INSIGHT_REGISTRY: InsightDefinition<unknown>[] = [usageIdeasInsight]

export function getInsightDefinition(id: string): InsightDefinition<unknown> | undefined {
  return INSIGHT_REGISTRY.find((definition) => definition.id === id)
}
