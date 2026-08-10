import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { extractByLlm, isDailyQuotaError, isLlmProviderUnavailable, type LlmConfig, type PhotoCuration } from '~/server/utils/extract/llm'
import { mergeLlmResult } from '~/server/utils/extract/merge-llm-result'
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
} | null> {
  const artifactState = opts.artifactState ?? await readArtifactProcessingState(platform, externalId)
  let base = opts.prebuiltBase
    ?? await buildReprocessInput(platform, externalId, priorEntry, llmConfig, { artifactState })
  if (!base) return null

  if (!llmConfig) {
    return {
      entry: buildRulesOnlyEntry(base.fields, priorEntry, at),
      llmCalled: false,
      llmFailures: opts.priorLlmFailures ?? 0,
      artifactVersionId: artifactState.parsedArtifactVersionId,
      auction: base.auction,
      llmConfigUsed: null,
      llmDurationMs: null,
    }
  }

  const configs = [llmConfig, ...(opts.fallbackConfigs ?? [])]
  let llm: Awaited<ReturnType<typeof extractByLlm>> = null
  let llmConfigUsed: LlmConfig | null = null
  let llmDurationMs: number | null = null
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
    try {
      // Provenance hangs off onProviderAttempt, not off "extractByLlm
      // returned": it bails out with null *before* attempting when the
      // archived snapshot yields no parts at all (no title, no description,
      // no documents), and stamping that rules-only version with a model
      // that was never asked would misreport it on the WP-2 admin page.
      let providerAttempted = false
      const attemptStartedAt = Date.now()
      llm = await extractByLlm(base.input!, config, {
        onProviderAttempt: () => {
          providerAttempted = true
          opts.onLlmAttempt?.()
        },
        onProviderError: opts.onLlmError,
      })
      if (providerAttempted) {
        llmConfigUsed = config
        llmDurationMs = Date.now() - attemptStartedAt
      }
      break
    } catch (err) {
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
  const entry = mergeLlmResult(effectivePriorEntry, base.fields, llm, at, curatedPhotos)
  return {
    entry,
    llmCalled: true,
    llmFailures: llm === null ? (opts.priorLlmFailures ?? 0) + 1 : 0,
    artifactVersionId: parsedCurrentSet
      ? base.artifactVersionId
      : artifactState.parsedArtifactVersionId,
    auction: base.auction,
    llmConfigUsed,
    llmDurationMs,
  }
}
