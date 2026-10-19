import type { Auction, AuctionExtraction } from '~/types/auction'
import { isLlmBatchPending } from '~/server/utils/extract/llm-batch'
import { LLM_FAILURE_RETRY_COOLDOWN_HOURS, MAX_LLM_FAILURES } from '~/server/utils/extract/llm-task-config'
import type { ArtifactProcessingState } from '~/server/utils/artifact-version-state'
import type { AuctionFetchState } from '~/server/utils/auction-fetch-state'
import { buildReprocessFields } from '~/server/utils/extract/reprocess-fields'
import { hasNewArchivedDocuments, type ReprocessOptions } from './reprocess-input'

/** Whether a locked-out auction (llm_failures >= MAX_LLM_FAILURES) is past
 *  its cooldown and can retry again — see LLM_FAILURE_RETRY_COOLDOWN_HOURS.
 *  A never-attempted timestamp (older rows predating this column, or a
 *  chain that's never actually made a request) counts as elapsed rather
 *  than blocking eligibility on a value that doesn't exist yet. */
export function cooldownElapsed(lastAttemptedAt: string | null | undefined, nowMs: number): boolean {
  if (!lastAttemptedAt) return true
  return nowMs - new Date(lastAttemptedAt).getTime() >= LLM_FAILURE_RETRY_COOLDOWN_HOURS * 60 * 60 * 1000
}

/** Whether runReprocess should work on this candidate at all. */
export function isReprocessEligible(
  opts: ReprocessOptions,
  candidate: {
    priorEntry: AuctionExtraction | undefined
    priorState: AuctionFetchState | undefined
    artifactState: ArtifactProcessingState
    llmConfigured: boolean
    nowMs: number
  },
): boolean {
  const { priorEntry, priorState, artifactState, llmConfigured, nowMs } = candidate
  const priorLlmFailures = priorState?.llmFailures ?? 0
  // `undefined` means an optional field was absent from an otherwise
  // valid model response, not that the whole auction is unprocessed.
  // Treating each optional field as a retry criterion caused the cron to
  // send successful auctions to the LLM again every hour.  A completed
  // LLM extraction is explicitly marked by llmAnalyzedAt; changed source
  // documents still make it eligible through hasNewArchivedDocuments.
  const hasSuccessfulLlmExtraction = priorEntry?.llmAnalyzedAt != null
  return (
    (!opts.failedOnly || priorLlmFailures >= MAX_LLM_FAILURES) &&
    (!!opts.force ||
      ((!priorEntry ||
        (priorEntry.source === 'rules' && priorEntry.confidence === 'low') ||
        (llmConfigured && !hasSuccessfulLlmExtraction) ||
        hasNewArchivedDocuments(artifactState)) &&
        (priorLlmFailures < MAX_LLM_FAILURES ||
          (!opts.openOnly && (cooldownElapsed(priorState?.llmLastAttemptedAt, nowMs) || !!opts.ignoreCooldown))) &&
        (!!opts.ignoreBatchPending || !isLlmBatchPending(priorState?.llmBatchJob
          ? { llmBatchJob: priorState.llmBatchJob, at: priorState.updatedAt }
          : undefined))))
  )
}

const RULES_OWNED_FIELDS = ['propertyType', 'landAreaSqm', 'livingAreaSqm', 'rooms', 'units', 'securityDeposit'] as const

/**
 * Whether a rules-only pass could change the stored entry at all. Without an
 * LLM result reprocessAuction keeps an LLM extraction's values, so there is
 * nothing to gain for one; a rules entry only changes when the rules now
 * derive different values. Those are checked against the stored record's
 * own title/description/source values rather than the archived snapshot,
 * whose blob downloads are exactly the cost being avoided — the two come
 * from the same crawl, and where they disagree the candidate is rebuilt.
 */
export function rulesOnlyRebuildChangesEntry(auction: Auction, stored: AuctionExtraction): boolean {
  if (stored.llmAnalyzedAt != null || stored.source === 'llm') return false
  const fields = buildReprocessFields(auction, undefined, true)
  return RULES_OWNED_FIELDS.some((field) => (fields[field] ?? null) !== (stored[field] ?? null))
}
