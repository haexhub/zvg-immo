import { readExtractionLlmConfigChain } from '~/server/utils/extract/llm-task-config'
import type { ReprocessOptions, ReprocessResult } from './reprocess-input'
import { runReprocess } from './reprocess-run'

/** Locked-out auctions the scheduled run retries per run. The cron's own LLM
 *  budget (extractLlm.maxPerRun) is spread over every platform and over a
 *  candidate list dominated by never-extracted auctions, so a locked auction
 *  was reached only by chance — thousands stayed locked for weeks. A small
 *  dedicated slice, oldest attempt first, drains them predictably. */
export const DEFAULT_LOCKED_RETRY_PER_RUN = 10

/** `NUXT_EXTRACT_LLM_LOCKED_RETRY_PER_RUN`; 0 turns the slice off. */
export function readLockedRetryPerRun(): number {
  const raw = (useRuntimeConfig().extractLlm as { lockedRetryPerRun?: string } | undefined)?.lockedRetryPerRun
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_LOCKED_RETRY_PER_RUN
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_LOCKED_RETRY_PER_RUN
}

/** A plain scheduled/boot run: no manual trigger and none of the scope or
 *  mode options a /settings action carries. Only those get the slice — a
 *  scoped manual run does exactly what it was asked to. */
export function isPlainScheduledRun(options: ReprocessOptions): boolean {
  if (options.trigger === 'manual') return false
  return !(
    options.country || options.platform || options.externalId || options.caseNumber ||
    options.force || options.limit || options.failedOnly || options.openOnly || options.batch
  )
}

/**
 * Retries a bounded slice of locked-out auctions (llm_failures >=
 * MAX_LLM_FAILURES, no successful extraction), longest-unattempted first, with
 * the configured chain. Returns null when it did not run (disabled, no LLM
 * configured). A rate limit or provider outage ends the slice early inside
 * runReprocess and is reported through the result's `warning`; it never counts
 * as a failure for the auctions concerned.
 */
export async function runLockedRetrySlice(signal?: AbortSignal): Promise<ReprocessResult | null> {
  const limit = readLockedRetryPerRun()
  if (limit === 0) return null
  // Without a configured chain runReprocess would only rebuild rules-only
  // entries for these auctions, which fixes nothing and just churns versions.
  if ((await readExtractionLlmConfigChain()).length === 0) return null
  const result = await runReprocess({
    failedOnly: true,
    ignoreCooldown: true,
    ignoreBatchPending: true,
    ignoreLlmBudget: true,
    batch: false,
    limit,
    trigger: 'cron',
  }, signal)
  console.log(
    `[reprocess] locked retry slice: candidates=${result.candidates} processed=${result.processed} llmCalls=${result.llmCalls} llmErrors=${result.llmErrors}${result.warning ? ` warning="${result.warning}"` : ''}`,
  )
  return result
}
