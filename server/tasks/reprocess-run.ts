import type { Auction, AuctionExtraction } from '~/types/auction'
import { batchSupportsMultimodal, isLlmBatchPending, isLlmBatchProviderBroken, submitLlmBatch, supportsLlmBatch, supportsNativeBatchDocuments } from '~/server/utils/extract/llm-batch'
import { readLlmExecutionMode } from '~/server/utils/app-settings'
import { LLM_FAILURE_RETRY_COOLDOWN_HOURS, MAX_LLM_FAILURES, readExtractionChainStrategy, readExtractionLlmConfigChain } from '~/server/utils/extract/llm-task-config'
import { type LlmConfig, type LlmInput, isLlmProviderError, isRateLimitError } from '~/server/utils/extract/llm'
import { applyAuctionExtraction } from '~/server/utils/auction-extraction'
import { readAuctionRecordMap, type AuctionRecord } from '~/server/utils/auction-record'
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { readArtifactProcessingState } from '~/server/utils/artifact-version-state'
import { readAuctionFetchStates, writeAuctionLlmPipelineState } from '~/server/utils/auction-fetch-state'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { recordTaskRunError } from '~/server/utils/task-run-errors'
import { recordTaskRunProgress, type TaskRunSummary } from '~/server/utils/task-runs'
import { throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { buildLlmRateLimitWarning, buildReprocessInput, buildRulesOnlyEntry, effectiveCandidateCountries, findCandidates, hasNewArchivedDocuments, inputNeedsMultimodal, readMaxLlmPerRun, type ReprocessInput, type ReprocessOptions, type ReprocessResult } from './reprocess-input'
import { reprocessAuction } from './reprocess-single'

export async function runReprocess(opts: ReprocessOptions = {}, signal?: AbortSignal): Promise<ReprocessResult> {
  const startedAt = Date.now()
  if (opts.force && !opts.country && !opts.platform && !opts.externalId && !opts.caseNumber && !opts.limit) {
    throw new Error(
      '[reprocess] force requires country/platform/externalId/caseNumber or limit — an unbounded forced re-run would re-spend the LLM budget on every already-extracted auction',
    )
  }

  const candidateCountries = await effectiveCandidateCountries(opts)
  const rawCandidates = await findCandidates(opts, candidateCountries)
  const candidates = interleaveByPlatform(rawCandidates)
  if (candidates.length === 0) {
    const durationMs = Date.now() - startedAt
    console.log(`[reprocess] candidates=0 processed=0 skipped=0 llmCalls=0 in ${(durationMs / 1000).toFixed(0)}s`)
    return { candidates: 0, processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0, durationMs }
  }
  const records = await readAuctionRecordMap(opts.country)
  const fetchStates = await readAuctionFetchStates()
  // Batch submission (below) is committed to one model per job, so only the
  // sync path (reprocessAuction, further down) gets the rest of the chain as
  // automatic fallback — llmConfig itself stays the primary everywhere else
  // (logging, batch capability checks) exactly as before.
  const llmConfigs = await readExtractionLlmConfigChain()
  const llmConfig = llmConfigs[0] ?? null
  /** Configs that reported a per-day quota during this run — see the sync
   *  path below. Keyed by object identity, so the same model configured twice
   *  with different API keys (i.e. different projects, each with its own
   *  quota) is tracked separately. */
  const exhaustedConfigs = new Set<LlmConfig>()
  const chainStrategy = await readExtractionChainStrategy()
  /** Rotates the chain's starting point under 'round-robin' (see
   *  LLM_CHAIN_STRATEGIES). Counted per candidate that reaches the sync LLM
   *  path, not per request, so consecutive auctions land on different API keys
   *  — which is the whole point: each key is its own project with its own
   *  per-minute quota, and gemini-native paces per key. */
  let chainCursor = 0
  const executionMode = await readLlmExecutionMode()
  const maxLlmPerRun = readMaxLlmPerRun()
  const at = new Date().toISOString()
  const nowMs = new Date(at).getTime()
  /** Whether a locked-out auction (llm_failures >= MAX_LLM_FAILURES) is past
   *  its cooldown and can retry again — see LLM_FAILURE_RETRY_COOLDOWN_HOURS.
   *  A never-attempted timestamp (older rows predating this column, or a
   *  chain that's never actually made a request) counts as elapsed rather
   *  than blocking eligibility on a value that doesn't exist yet. */
  function cooldownElapsed(lastAttemptedAt: string | null | undefined): boolean {
    if (!lastAttemptedAt) return true
    return nowMs - new Date(lastAttemptedAt).getTime() >= LLM_FAILURE_RETRY_COOLDOWN_HOURS * 60 * 60 * 1000
  }
  // Any provider without a Batch API integration falls back to the
  // synchronous path even if `batch: true` was requested.
  const batchRequested = opts.batch ?? executionMode === 'batch'
  // opts.batch === true is always an explicit choice (the /settings "Submit
  // via Batch API" checkbox) — unlike the executionMode-derived default,
  // that's the deliberate recovery probe the PR added, so it must reach the
  // provider even when marked known-broken, or the capability could never
  // clear back to ok:true once set.
  const isExplicitBatchProbe = opts.batch === true
  const batchProviderBroken = batchRequested && !isExplicitBatchProbe && (await isLlmBatchProviderBroken(llmConfig))
  if (batchProviderBroken) {
    console.warn(
      `[reprocess] batch mode requested but ${llmConfig?.provider} is known-broken (see /settings) — falling back to sync`,
    )
  }
  const useBatch = batchRequested && supportsLlmBatch(llmConfig) && !batchProviderBroken
  if (llmConfig) {
    // '→' reads as the fallback order it is; round-robin has no primary, so it
    // gets '+' instead of implying one.
    const chainLabel = llmConfigs
      .map((c) => `${c.provider ?? 'openai-compatible'}/${c.model}`)
      .join(chainStrategy === 'round-robin' ? ' + ' : ' → ')
    console.log(
      `[reprocess] llm ${chainLabel} strategy=${chainStrategy} mode=${useBatch ? 'batch' : 'sync'} maxPerRun=${maxLlmPerRun}`,
    )
  } else {
    console.log('[reprocess] llm disabled — rules-only')
  }

  // maxLlmPerRun is shared across all platforms; a per-platform cap keeps one
  // huge platform's backlog from burning through the whole budget before
  // smaller platforms' listings are ever reached (same rationale enrich.ts
  // used to apply — see interleave-by-platform.ts).
  const llmPlatformCount = new Set(candidates.map((c) => c.platform)).size || 1
  const llmCapPerPlatform = Math.max(1, Math.ceil(maxLlmPerRun / llmPlatformCount))
  const llmCallsByPlatform = new Map<string, number>()

  // Per-country breakdown for /settings — diffed from the aggregate counters
  // below in the loop's `finally` block rather than incremented at each of
  // their many call sites, since every increment happens somewhere within
  // one candidate's iteration regardless of which branch it took.
  const candidatesTotalByCountry = new Map<string, number>()
  for (const c of candidates) candidatesTotalByCountry.set(c.country, (candidatesTotalByCountry.get(c.country) ?? 0) + 1)
  // Seeded at 0/N so every country in scope shows up right away instead of
  // appearing one by one as the loop reaches it — and so a run that stops
  // early (rate limit) still reports the countries it never got to.
  const progressByCountry = new Map<string, TaskRunSummary>(
    [...candidatesTotalByCountry].map(([country, candidatesTotal]) => [
      country,
      { candidatesTotal, processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0 },
    ]),
  )

  let processed = 0
  let skipped = 0
  let llmCalls = 0
  let llmErrors = 0
  let lastLlmError: string | undefined
  let warning: string | undefined
  const batchItems: { key: string; input: LlmInput }[] = []
  const batchArtifactVersions = new Map<string, number | null>()

  // Distinguishes a persistEntry (DB write) failure from an LLM-call failure
  // in the catch block below — both land there, but they need different
  // task_run_errors categories (a storage outage isn't an LLM problem).
  const persistFailureMark = Symbol('persistFailure')
  function markPersistFailure(err: unknown): unknown {
    if (err instanceof Error) (err as Error & { [persistFailureMark]?: true })[persistFailureMark] = true
    return err
  }
  function isPersistFailure(err: unknown): boolean {
    return err instanceof Error && persistFailureMark in err
  }

  async function persistEntry(
    record: AuctionRecord,
    entry: AuctionExtraction,
    artifactVersionId: number | null,
    llmFailures: number,
    archivedAuction: Auction,
    llmAttempted: boolean,
    llmConfigUsed: LlmConfig | null = null,
    llmDurationMs: number | null = null,
  ): Promise<void> {
    // record.auction is reconstructed from auctions LEFT JOIN LATERAL
    // auction_details (see auction-record.ts) — when no auction_details row
    // exists yet (a brand-new identity, or one whose details were wiped, e.g.
    // by rebuildCountry), every crawl-owned field on it is null/0. This task
    // never crawls live, so without this fallback that blank snapshot would
    // become the permanent first version — address stays empty forever and
    // geocoding never gets a query to run (see WP-3 SE root cause). The
    // archived 'auction' capture this run already read is the actual crawl
    // output and the correct source for that first write; lat/lng stay from
    // record.auction since geocoding writes there independently and may be
    // newer than the archive.
    const base = record.detailsId == null
      ? { ...archivedAuction, lat: record.auction.lat, lng: record.auction.lng }
      : record.auction
    const updated: Auction = { ...base, extraction: entry }
    applyAuctionExtraction(updated, entry)
    await writeAuctionDetails(updated, entry, {
      artifactVersionId,
      llmProvider: llmConfigUsed ? (llmConfigUsed.provider ?? 'openai-compatible') : null,
      llmModel: llmConfigUsed?.model ?? null,
      llmProfileId: llmConfigUsed?.profileId ?? null,
      runTrigger: opts.trigger ?? 'cron',
      llmDurationMs,
    })
    await upsertCurrentAuctions([updated], at)
    await writeAuctionLlmPipelineState(record.auction.platform, record.auction.externalId, {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures,
      llmAttempted,
    })
    record.auction = updated
    record.artifactVersionId = artifactVersionId
  }

  for (const { platform, externalId, country } of candidates) {
    throwIfTaskAborted(signal)
    const before = { processed, skipped, llmCalls, llmErrors }
    // Hoisted out of the try block below so the catch can still see them: a
    // thrown rate-limit/unparseable-response error (see the catch's comment)
    // reaches onLlmAttempt before propagating past reprocessAuction, and the
    // cooldown timestamp needs recording even though this candidate never
    // reaches persistEntry.
    let syncLlmAttempted = false
    let priorLlmFailures = 0
    try {
      const key = cacheKey(platform, externalId)
      const record = records.get(key)
      if (!record) {
        skipped++
        continue
      }
      const storedPriorEntry = record.auction.extraction ?? undefined
      const priorState = fetchStates.get(key)
      const priorEntry = storedPriorEntry
      priorLlmFailures = priorState?.llmFailures ?? 0
      const artifactState = await readArtifactProcessingState(platform, externalId)
      const hasMissingLlmOnlyField = priorEntry
        ? priorEntry.condition === undefined ||
          priorEntry.features === undefined ||
          priorEntry.bedrooms === undefined ||
          priorEntry.bathrooms === undefined ||
          priorEntry.floor === undefined ||
          priorEntry.bathroomHasTub === undefined ||
          priorEntry.bathroomHasShower === undefined ||
          priorEntry.heating === undefined ||
          priorEntry.yearBuilt === undefined ||
          priorEntry.lastRenovationYear === undefined ||
          priorEntry.renovationNotes === undefined ||
          priorEntry.insights === undefined ||
          priorEntry.planningNotes === undefined ||
          priorEntry.documentSummary === undefined ||
          priorEntry.marketValueEur === undefined
        : false
      const eligible =
        opts.force ||
        ((!priorEntry ||
          (priorEntry.source === 'rules' && priorEntry.confidence === 'low') ||
          (llmConfig != null && hasMissingLlmOnlyField) ||
          hasNewArchivedDocuments(artifactState)) &&
          (priorLlmFailures < MAX_LLM_FAILURES || cooldownElapsed(priorState?.llmLastAttemptedAt)) &&
          !isLlmBatchPending(priorState?.llmBatchJob
            ? { llmBatchJob: priorState.llmBatchJob, at: priorState.updatedAt }
            : undefined))
      if (!eligible) {
        skipped++
        continue
      }

      const platformLlmCalls = llmCallsByPlatform.get(platform) ?? 0
      const llmReady = !!llmConfig && llmCalls < maxLlmPerRun && platformLlmCalls < llmCapPerPlatform
      if (opts.force && llmConfig && !llmReady) {
        skipped++
        continue
      }

      /** Set only when the batch path built an input and then handed the
       *  candidate to the synchronous path below, which reuses it rather than
       *  rebuilding the same document set (see reprocessAuction's
       *  `prebuiltBase`). Safe to reuse across those two paths because the
       *  fall-through is unreachable for the providers whose input actually
       *  differs between them: supportsNativeBatchDocuments() and
       *  buildReprocessInput's own `nativeDocuments` default only disagree for
       *  gemini-native/claude-proxy, and both are batch-multimodal, so they
       *  never fall through. */
      let batchFallbackBase: ReprocessInput | undefined
      if (useBatch && llmReady) {
        const base = await buildReprocessInput(platform, externalId, priorEntry, llmConfig, {
          nativeDocuments: supportsNativeBatchDocuments(llmConfig),
          artifactState,
        })
        if (!base || !base.input) {
          skipped++
          continue
        }
        // A candidate the configured batch provider can't take (OpenRouter's
        // Batch API rejects any image/document content outright — see
        // batchSupportsMultimodal) falls through to the synchronous path
        // below instead of being queued: submitting it would just skip it
        // into retryItems, and since that never sets an llmBatchJob marker,
        // it would stay eligible and get queued into the same doomed batch
        // again every run, forever.
        if (batchSupportsMultimodal(llmConfig) || !inputNeedsMultimodal(base.input)) {
          llmCalls++
          llmCallsByPlatform.set(platform, platformLlmCalls + 1)
          batchItems.push({ key, input: base.input })
          batchArtifactVersions.set(key, base.artifactVersionId)
          // Keep the currently visible extraction intact while the replacement
          // is pending. The poller rebuilds a fresh merge base for changed sets.
          const entry = base.documentSetChanged && priorEntry
            ? priorEntry
            : buildRulesOnlyEntry(base.fields, priorEntry, at)
          processed++
          // llmAttempted: false — queued, not yet submitted. The batch
          // submission loop below marks the real attempt once it actually
          // goes out (only some queued items may make it into submitted).
          await persistEntry(record, entry, artifactState.parsedArtifactVersionId, priorLlmFailures, base.auction, false)
            .catch((persistErr) => { throw markPersistFailure(persistErr) })
          continue
        }
        batchFallbackBase = base
      }

      // Models already known to be over their daily quota are dropped from
      // this run's chain entirely: retrying them costs a full failed attempt
      // per candidate (~50 s with the provider's pacing) and cannot succeed
      // before the quota resets at midnight Pacific.
      const available = llmReady ? llmConfigs.filter((config) => !exhaustedConfigs.has(config)) : []
      // Rotation happens over the *surviving* configs, so a chain that lost a
      // link to its daily quota keeps spreading evenly over the rest instead of
      // handing every nth auction to a model that can no longer answer.
      const offset = chainStrategy === 'round-robin' && available.length > 1
        ? chainCursor++ % available.length
        : 0
      const syncConfigs = offset === 0 ? available : [...available.slice(offset), ...available.slice(0, offset)]
      if (llmReady && syncConfigs.length === 0) {
        warning = 'Alle konfigurierten LLM-Modelle haben ihr Tageskontingent erreicht.'
        console.warn('[reprocess] every configured model is over its daily quota — stopping this run early')
        skipped++
        break
      }

      let platformLlmCallsSoFar = platformLlmCalls
      const result = await reprocessAuction(platform, externalId, priorEntry, syncConfigs[0] ?? null, at, {
        artifactState,
        priorLlmFailures,
        // Only handed over when the sync path starts on the very config the
        // input above was built for — a rotated or quota-filtered chain head
        // is a different provider and has to build its own.
        prebuiltBase: syncConfigs[0] === llmConfig ? batchFallbackBase : undefined,
        fallbackConfigs: syncConfigs.slice(1),
        onDailyQuotaExhausted: (config) => {
          if (exhaustedConfigs.has(config)) return
          exhaustedConfigs.add(config)
          console.warn(
            `[reprocess] ${config.provider ?? 'openai-compatible'}/${config.model} is over its daily quota — skipping it for the rest of this run`,
          )
        },
        onLlmAttempt: () => {
          syncLlmAttempted = true
          llmCalls++
          platformLlmCallsSoFar++
          llmCallsByPlatform.set(platform, platformLlmCallsSoFar)
        },
        onLlmError: (err) => {
          llmErrors++
          const message = err instanceof Error ? err.message : String(err)
          lastLlmError = `${platform}:${externalId}: ${message}`
        },
      })
      if (!result) {
        skipped++
        continue
      }
      if (result.llmCalled && !syncLlmAttempted) {
        llmCalls++
        llmCallsByPlatform.set(platform, platformLlmCallsSoFar + 1)
      }

      processed++

      // Persist each result immediately so a long run survives a deployment.
      await persistEntry(
        record, result.entry, result.artifactVersionId, result.llmFailures, result.auction, result.llmCalled,
        result.llmConfigUsed, result.llmDurationMs,
      ).catch((persistErr) => { throw markPersistFailure(persistErr) })
    } catch (err) {
      // Also where a rate limit/quota error (see llm.ts's isRateLimitError())
      // lands: reprocessAuction/extractByLlm deliberately let it propagate
      // here instead of resolving to null, so the stored details stay untouched
      // — a capacity outage must never count toward llmFailures/
      // MAX_LLM_FAILURES, or it would permanently downgrade the auction to
      // rules-only once the limit is hit, long after the outage clears.
      console.warn(`[reprocess] failed for ${platform}:${externalId}: ${(err as Error).message}`)
      skipped++
      void recordTaskRunError('reprocess', {
        platform,
        externalId,
        // persistEntry failures (DB writes) are marked below so a storage
        // outage doesn't masquerade as an LLM failure in the error log —
        // the two need different on-call responses.
        category: isPersistFailure(err) ? 'persist' : isRateLimitError(err) ? 'rate_limit' : isLlmProviderError(err) ? 'llm_provider' : 'llm',
        message: err instanceof Error ? err.message : String(err),
      })
      if (syncLlmAttempted) {
        // A real request went out this iteration even though the outcome
        // never reached persistEntry (thrown, not resolved to null) — record
        // it so a locked-out auction's 24h cooldown (see cooldownElapsed)
        // actually advances instead of re-triggering every run forever.
        // llmFailures stays at its prior count: a capacity outage still must
        // never count toward MAX_LLM_FAILURES (see the comment above).
        await writeAuctionLlmPipelineState(platform, externalId, {
          llmBatchJob: null,
          llmArtifactVersionId: null,
          llmFailures: priorLlmFailures,
          llmAttempted: true,
        })
      }
      if (isRateLimitError(err)) {
        warning = buildLlmRateLimitWarning(err, llmConfig)
        console.warn('[reprocess] LLM provider rate-limited — stopping this run early')
        break
      }
      if (isLlmProviderError(err)) {
        warning = `LLM-Providerfehler: ${err.message}`
        console.warn('[reprocess] LLM provider unavailable — stopping this run early')
        break
      }
    } finally {
      const prevCountry = progressByCountry.get(country)
      progressByCountry.set(country, {
        candidatesTotal: candidatesTotalByCountry.get(country) ?? 0,
        processed: (prevCountry?.processed ?? 0) + (processed - before.processed),
        skipped: (prevCountry?.skipped ?? 0) + (skipped - before.skipped),
        llmCalls: (prevCountry?.llmCalls ?? 0) + (llmCalls - before.llmCalls),
        llmErrors: (prevCountry?.llmErrors ?? 0) + (llmErrors - before.llmErrors),
      })
      void recordTaskRunProgress(
        'reprocess',
        { candidatesTotal: candidates.length, processed, skipped, llmCalls, llmErrors },
        { lastLlmError, progressByCountry: Object.fromEntries(progressByCountry) },
      )
    }
  }
  // The per-country snapshot outlives the run in /settings, so its final
  // state has to get past the progress throttle — with a fast loop the last
  // in-loop reports above are routinely swallowed by it.
  await recordTaskRunProgress(
    'reprocess',
    { candidatesTotal: candidates.length, processed, skipped, llmCalls, llmErrors },
    { lastLlmError, progressByCountry: Object.fromEntries(progressByCountry), flush: true },
  )

  if (batchItems.length > 0 && llmConfig) {
    const submission = await submitLlmBatch(batchItems, llmConfig, 'reprocess')
    if (submission) {
      // Same rationale enrich.ts used to apply: mark every submitted item so
      // a second runReprocess({ batch: true }) call doesn't re-submit it to a
      // new job while this one is still in flight (job submission isn't
      // idempotent).
      for (const item of submission.submitted) {
        const separator = item.key.indexOf(':')
        if (separator > 0) {
          await writeAuctionLlmPipelineState(
            item.key.slice(0, separator),
            item.key.slice(separator + 1),
            {
              llmBatchJob: item.jobName,
              llmArtifactVersionId: batchArtifactVersions.get(item.key) ?? null,
              llmFailures: fetchStates.get(item.key)?.llmFailures ?? 0,
              llmAttempted: true,
            },
          )
        }
      }
      console.log(`[reprocess] submitted LLM batch ${submission.jobName} with ${submission.submitted.length} items`)
      if (submission.retryItems.length > 0) {
        console.warn(`[reprocess] ${submission.retryItems.length} LLM batch item(s) were not submitted`)
      }
    } else {
      console.warn(`[reprocess] LLM batch submission failed for ${batchItems.length} items`)
    }
  }

  const durationMs = Date.now() - startedAt
  console.log(
    `[reprocess] candidates=${candidates.length} processed=${processed} skipped=${skipped} llmCalls=${llmCalls} llmErrors=${llmErrors} in ${(durationMs / 1000).toFixed(0)}s`,
  )
  return {
    candidates: candidates.length,
    processed,
    skipped,
    llmCalls,
    llmErrors,
    durationMs,
    ...(warning ? { warning } : {}),
    ...(lastLlmError ? { lastLlmError } : {}),
  }
}
