import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { extractByLlm, isDailyQuotaError, isLlmProviderUnavailable, type LlmConfig, type LlmUsage, type PhotoCuration } from '~/server/utils/extract/llm'
import { falsifiedRuleFields, mergeLlmResult, ruleChecksMatchingHint, type RuleCheckedField } from '~/server/utils/extract/merge-llm-result'
import { readArtifactProcessingState, type ArtifactProcessingState } from '~/server/utils/artifact-version-state'
import { normalizePhoto } from '~/lib/photo'
import { applyPhotoCuration, buildReprocessInput, buildRulesOnlyEntry, type ReprocessInput } from './reprocess-input'

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
  } = {},
): Promise<{
  entry: AuctionExtraction
  /** Rules values this call's LLM result explicitly refuted and replaced —
   *  runReprocess counts them into ReprocessResult.rulesFalsified. */
  rulesFalsified: RuleCheckedField[]
  llmCalled: boolean
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
    ?? await buildReprocessInput(platform, externalId, priorEntry, llmConfig, { artifactState })
  if (!base) return null

  if (!llmConfig) {
    return {
      entry: buildRulesOnlyEntry(base.fields, priorEntry, at),
      rulesFalsified: [],
      llmCalled: false,
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
    let providerAttempted = false
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
          providerAttempted = true
          opts.onLlmAttempt?.()
        },
        onProviderError: (err) => {
          providerError = err instanceof Error ? err.message : String(err)
          opts.onLlmError?.(err)
        },
        onUsage: (usage) => { attemptUsage = usage },
      })
      if (providerAttempted) {
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
      if (providerAttempted) {
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
  const effectivePriorEntry = base.documentSetChanged ? undefined : priorEntry
  const parsedCurrentSet = llm != null && base.documentSetComplete
  // Same filter the batch path applies: base.fields still carries the
  // platform-reported rooms/securityDeposit that buildReprocessInput
  // deliberately kept out of the hint, so an unsolicited `false` for one of
  // them must not reach the merge.
  const verified = llm && {
    ...llm,
    ruleCheck: ruleChecksMatchingHint(llm.ruleCheck, base.input?.rulesHint ?? null, base.fields),
  }
  const entry = mergeLlmResult(effectivePriorEntry, base.fields, verified, at, curatedPhotos)
  const rulesFalsified = falsifiedRuleFields(base.fields, verified)
  if (rulesFalsified.length) {
    console.warn(`[reprocess] llm overruled rules value(s) for ${platform}:${externalId}: ${rulesFalsified.join(',')}`)
  }
  return {
    entry,
    rulesFalsified,
    llmCalled: true,
    llmFailures: llm === null ? (opts.priorLlmFailures ?? 0) + 1 : 0,
    artifactVersionId: parsedCurrentSet
      ? base.artifactVersionId
      : artifactState.parsedArtifactVersionId,
    auction: base.auction,
    llmConfigUsed,
    llmDurationMs,
    llmUsage,
  }
}
