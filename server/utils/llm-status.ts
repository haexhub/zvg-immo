// Shared LLM-extraction status classification for one auction, used by both
// the /settings backlog overview (llm-batch-jobs.get.ts) and the per-country
// status donut (llm-status.get.ts / llm-status/[country].get.ts) so the
// definition of "still needs an LLM attempt" can't drift between them.

import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import type { AuctionExtraction } from '~/types/auction'
import type { AuctionRecord } from './auction-record'

export function hasMissingLlmFields(entry: AuctionExtraction): boolean {
  return (
    entry.condition === undefined ||
    entry.features === undefined ||
    entry.bedrooms === undefined ||
    entry.bathrooms === undefined ||
    entry.floor === undefined ||
    entry.bathroomHasTub === undefined ||
    entry.bathroomHasShower === undefined ||
    entry.heating === undefined ||
    entry.yearBuilt === undefined ||
    entry.lastRenovationYear === undefined ||
    entry.renovationNotes === undefined ||
    entry.insights === undefined ||
    entry.planningNotes === undefined ||
    entry.documentSummary === undefined ||
    entry.marketValueEur === undefined
  )
}

export type LlmStatusBucket = 'done' | 'error' | 'open'

/** Mirrors the eligibility split llm-batch-jobs.get.ts already computes for
 *  the global backlog counters: an auction is 'open' when it has never been
 *  extracted, is stuck on low-confidence rules, or is missing LLM-only
 *  fields — unless it's locked out (llm_failures >= MAX_LLM_FAILURES), which
 *  takes priority and counts as 'error'. Everything else is 'done'. */
export function classifyLlmStatus(record: AuctionRecord): LlmStatusBucket {
  if ((record.auction.processing?.llmFailures ?? 0) >= MAX_LLM_FAILURES) return 'error'
  const entry = record.auction.extraction
  const isUnextracted = !entry
  const lowRules = !isUnextracted && entry.source === 'rules' && entry.confidence === 'low'
  const missingFields = !isUnextracted && hasMissingLlmFields(entry)
  return isUnextracted || lowRules || missingFields ? 'open' : 'done'
}
