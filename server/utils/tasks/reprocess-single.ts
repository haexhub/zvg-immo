import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { extractByLlm, type LlmConfig, type LlmUsage } from '~/server/utils/extract/llm'
import { isDailyQuotaError, isLlmProviderUnavailable } from '~/server/utils/extract/llm-errors'
import type { PhotoCuration } from '~/server/utils/extract/llm-clamp'
import { falsifiedRuleFields, mergeLlmResult, ruleChecksMatchingHint, type RuleCheckedField } from '~/server/utils/extract/merge-llm-result'
import { readArtifactProcessingState, type ArtifactProcessingState } from '~/server/utils/artifact-version-state'
import { priorLlmFields } from '~/server/utils/extract/reprocess-fields'
import { normalizePhoto } from '~/lib/photo'
import { applyPhotoCuration, buildReprocessInput, buildRulesOnlyEntry, type ReprocessInput } from './reprocess-input'
import { runMapReduceExtraction } from './reprocess-map-reduce'

export async function reprocessAuction(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  at: string,
  opts: {
    onLlmAttempt?: () => void
    onLlmError?: (err: unknown) => void
    /** Records the outcome of every actual provider invocation, including a
     * failed primary attempt before a fallback model succeeds. */
    onLlmCall?: (call: {
      config: LlmConfig
      durationMs: number
      usage: LlmUsage | null
      status: 'succeeded' | 'failed'
      errorMessage: string | null
    }) => void | Promise<void>
    /** Tried in order after `llmConfig`, only when the current model is
     *  rate-limited/over quota or otherwise unavailable (see
     *  isLlmProviderUnavailable) — not on a caller-side error. */
    fallbackConfigs?: LlmConfig[]
    /** Fires when a config turned out to be over its *daily* quota, which no
     *  amount of waiting fixes within this run. Lets the caller drop it from
     *  the chain for every remaining candidate instead of paying the failed
     *  attempt again and again (see runReprocess). */
    onDailyQuotaExhausted?: (config: LlmConfig) => void
    artifactState?: ArtifactProcessingState
    priorLlmFailures?: number
    /** An input the caller already built for this exact `llmConfig`.
     *  runReprocess's batch path builds one, then falls through to here when
     *  the provider's Batch API can't take the candidate (see
     *  batchSupportsMultimodal) — and buildReprocessInput re-downloads every
     *  archived blob and re-renders scanned PDF pages, so rebuilding it would
     *  pay for the whole document set twice per auction. */
    prebuiltBase?: ReprocessInput
    /** Caps how many map-reduce calls (map + reduce) this candidate may make
     *  this run — see runReprocess's remaining-budget computation. Ignored
     *  outside the map-reduce path (base.documentSummaryInputs unset). Excess
     *  documents are deferred into the reduce prompt and remain eligible for
     *  a later run with more budget. */
    remainingLlmBudget?: number
    /** Atomically reserves as many calls as are available for this candidate.
     * Used by the parallel reprocess pool so map-reduce calls cannot all pass
     * the same stale remaining-budget snapshot. Returns the total number of
     * calls currently reserved for this candidate. */
    reserveLlmCalls?: (requested: number) => number
  } = {},
): Promise<{
  entry: AuctionExtraction
  /** Rules values this call's LLM result explicitly refuted and replaced —
   *  runReprocess counts them into ReprocessResult.rulesFalsified. */
  rulesFalsified: RuleCheckedField[]
  llmCalled: boolean
  /** An LLM was configured, but the archived snapshot gave it nothing to read
   *  (no title, description or documents), so no request went out. Neither
   *  an LLM call nor a failure: counting it as one locked such auctions out
   *  after MAX_LLM_FAILURES "failures" that never reached a provider. The
   *  caller still records the attempt time so the auction drops behind
   *  never-attempted candidates instead of being picked first every run. */
  llmInputEmpty: boolean
  llmFailures: number
  artifactVersionId: number | null
  auction: Auction
  /** The config a provider request actually went out with — the fallback
   *  chain's winner, which can differ from the `llmConfig` param. Null when no
   *  request happened at all (WP-1 provenance). */
  llmConfigUsed: LlmConfig | null
  /** Wall-clock of that provider request, null alongside llmConfigUsed. Only
   *  the request itself: buildReprocessInput re-downloads every archived blob
   *  and rasterizes scanned PDF pages, which would otherwise dominate and
   *  make llm_duration_ms useless for comparing models. */
  llmDurationMs: number | null
  /** Token usage of that same request, null alongside llmConfigUsed — see
   *  server/utils/llm-usage.ts. */
  llmUsage: LlmUsage | null
} | null> {
  const artifactState = opts.artifactState ?? await readArtifactProcessingState(platform, externalId)
  let base = opts.prebuiltBase
    ?? await buildReprocessInput(platform, externalId, priorEntry, llmConfig, { artifactState, allowMapReduce: true })
  if (!base) return null

  if (!llmConfig) {
    return {
      entry: buildRulesOnlyEntry({ ...base.fields, ...priorLlmFields(priorEntry) }, priorEntry, at),
      rulesFalsified: [],
      llmCalled: false,
      llmInputEmpty: false,
      llmFailures: opts.priorLlmFailures ?? 0,
      artifactVersionId: artifactState.parsedArtifactVersionId,
      auction: base.auction,
      llmConfigUsed: null,
      llmDurationMs: null,
      llmUsage: null,
    }
  }

  const configs = [llmConfig, ...(opts.fallbackConfigs ?? [])]
  let llm: Awaited<ReturnType<typeof extractByLlm>> = null
  let llmConfigUsed: LlmConfig | null = null
  let llmDurationMs: number | null = null
  let llmUsage: LlmUsage | null = null
  let providerAttempted = false
  /** Map-reduce built its result without every document group. */
  let mapReduceIncomplete = false
  /** ...because at least one map call failed (not a budget cut). */
  let mapCallFailed = false
  const onLlmAttempt = () => {
    providerAttempted = true
    opts.onLlmAttempt?.()
  }

  if (base.documentSummaryInputs?.length) {
    // Map-reduce: no fallback chain here (unlike the loop below) — running
    // fallbackConfigs per-document would let a failing chain spend well past
    // the budget the caller computed (e.g. 5 calls on config A, then 5 more
    // on config B). A provider outage mid-sequence propagates out of
    // runMapReduceExtraction instead, exactly like a single call's would.
    const remaining = opts.reserveLlmCalls
      ? opts.reserveLlmCalls(base.documentSummaryInputs.length + 1)
      : opts.remainingLlmBudget ?? Infinity
    if (remaining < 2) return null
    const documentsForMapPhase = base.documentSummaryInputs.slice(0, remaining - 1)
    const budgetDeferredLabels = base.documentSummaryInputs
      .slice(documentsForMapPhase.length)
      .flatMap((group) => [
        ...(group.documentLabels ?? [group.label]),
        ...(group.deferredDocumentLabels ?? []),
      ])
    if (budgetDeferredLabels.length > 0 && documentsForMapPhase.length > 0) {
      const lastMapGroup = documentsForMapPhase.at(-1)!
      documentsForMapPhase[documentsForMapPhase.length - 1] = {
        ...lastMapGroup,
        deferredDocumentLabels: [
          ...(lastMapGroup.deferredDocumentLabels ?? []),
          ...budgetDeferredLabels,
        ],
      }
    }
    console.log(
      `[reprocess] map-reduce for ${platform}:${externalId} — ${documentsForMapPhase.length} document group(s) + 1 reduce call`,
    )
    const attemptStartedAt = Date.now()
    const mapReduce = await runMapReduceExtraction(documentsForMapPhase, base.input!, llmConfig, {
      onLlmAttempt,
      onLlmError: opts.onLlmError,
      onLlmCall: opts.onLlmCall,
    })
    llm = mapReduce.extraction
    // Groups cut for this run's budget or lost to a failed map call were
    // never read, so the set must stay unparsed for a later run to retry.
    // ponytail: a retry re-sends every group, not just the missing ones, and
    // a per-run budget below groups+1 never completes the set; per-group
    // parse state would fix both.
    mapCallFailed = mapReduce.failedMaps > 0
    mapReduceIncomplete = mapCallFailed || documentsForMapPhase.length < base.documentSummaryInputs.length
    llmConfigUsed = llmConfig
    // Wall-clock across every map+reduce call, not one request — the
    // per-request onLlmCall callback above already recorded each call's own
    // duration/usage individually via recordLlmUsage (llm_usage_events).
    llmDurationMs = Date.now() - attemptStartedAt
  } else {
    for (const [index, config] of configs.entries()) {
      if (index > 0) {
        // Rebuild rather than reuse base.input: nativeDocuments (gemini-native's
        // raw-PDF path vs. every other provider's rasterized images) depends on
        // which provider is actually being asked, and the fallback's provider
        // can differ from the one buildReprocessInput was first built for.
        const rebuilt = await buildReprocessInput(platform, externalId, priorEntry, config, { artifactState })
        if (!rebuilt) break
        base = rebuilt
      }
      let attemptStarted = false
      let providerError: string | null = null
      let attemptUsage: LlmUsage | null = null
      const attemptStartedAt = Date.now()
      try {
        // Provenance hangs off onProviderAttempt, not off "extractByLlm
        // returned": it bails out with null *before* attempting when the
        // archived snapshot yields no parts at all (no title, no description,
        // no documents), and stamping that rules-only version with a model
        // that was never asked would misreport it on the WP-2 admin page.
        llm = await extractByLlm(base.input!, config, {
          onProviderAttempt: () => {
            attemptStarted = true
            onLlmAttempt()
          },
          onProviderError: (err) => {
            providerError = err instanceof Error ? err.message : String(err)
            opts.onLlmError?.(err)
          },
          onUsage: (usage) => { attemptUsage = usage },
        })
        if (attemptStarted) {
          llmConfigUsed = config
          llmDurationMs = Date.now() - attemptStartedAt
          llmUsage = attemptUsage
          await opts.onLlmCall?.({
            config,
            durationMs: llmDurationMs,
            usage: attemptUsage,
            status: llm === null ? 'failed' : 'succeeded',
            errorMessage: llm === null ? providerError ?? 'Keine gültige Extraktion in der Provider-Antwort' : null,
          })
        }
        break
      } catch (err) {
        if (attemptStarted) {
          await opts.onLlmCall?.({
            config,
            durationMs: Date.now() - attemptStartedAt,
            usage: attemptUsage,
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
        if (isDailyQuotaError(err)) opts.onDailyQuotaExhausted?.(config)
        const isLast = index === configs.length - 1
        if (isLast || !isLlmProviderUnavailable(err)) throw err
        console.warn(
          `[reprocess] ${config.provider ?? 'openai-compatible'}/${config.model} unavailable for ${platform}:${externalId}, trying next configured model: ${(err as Error).message}`,
        )
      }
    }
  }
  let curatedPhotos = priorEntry?.photos?.map(normalizePhoto)
  if (llm && curatedPhotos && base.input?.candidateImages?.length && llm.photoCuration.length) {
    // llm.photoCuration's photoIndex is relative to the candidateImages that
    // were actually sent, which buildCandidateImages may have shrunk (dropped
    // unreadable photos) — remap through photoSourceIndices back to curatedPhotos'
    // original positions before applying.
    const sourceIndices = base.photoSourceIndices
    const curation = sourceIndices
      ? llm.photoCuration
          .map((c) => (sourceIndices[c.photoIndex] != null ? { ...c, photoIndex: sourceIndices[c.photoIndex] } : null))
          .filter((c): c is PhotoCuration => c != null)
      : llm.photoCuration
    curatedPhotos = applyPhotoCuration(curatedPhotos, curation)
  }
  const parsedCurrentSet = llm != null && base.documentSetComplete && !mapReduceIncomplete
  // Same filter the batch path applies: base.fields still carries the
  // platform-reported rooms/securityDeposit that buildReprocessInput
  // deliberately kept out of the hint, so an unsolicited `false` for one of
  // them must not reach the merge.
  const verified = llm && {
    ...llm,
    ruleCheck: ruleChecksMatchingHint(llm.ruleCheck, base.input?.rulesHint ?? null, base.fields),
  }
  // Without an LLM result the new document set stays unparsed (see
  // artifactVersionId below), so the auction remains eligible; until a later
  // run parses it, the prior LLM values and llmAnalyzedAt stay as they were
  // instead of a rules-only version replacing them. A result replaces every
  // LLM-owned field anyway.
  const mergeFields = llm ? base.fields : { ...base.fields, ...priorLlmFields(priorEntry) }
  const entry = mergeLlmResult(priorEntry, mergeFields, verified, at, curatedPhotos)
  const rulesFalsified = falsifiedRuleFields(base.fields, verified)
  if (rulesFalsified.length) {
    console.warn(`[reprocess] llm overruled rules value(s) for ${platform}:${externalId}: ${rulesFalsified.join(',')}`)
  }
  return {
    entry,
    rulesFalsified,
    llmCalled: providerAttempted,
    llmInputEmpty: !providerAttempted,
    // A failed map call counts like a failed call even when the reduce still
    // produced a result: the unstamped set keeps the auction eligible, and
    // without the counter (and its cooldown) it would re-send every group on
    // every run.
    llmFailures: llm === null || mapCallFailed
      ? (opts.priorLlmFailures ?? 0) + (providerAttempted ? 1 : 0)
      : 0,
    artifactVersionId: parsedCurrentSet
      ? base.artifactVersionId
      : artifactState.parsedArtifactVersionId,
    auction: base.auction,
    llmConfigUsed,
    llmDurationMs,
    llmUsage,
  }
}
