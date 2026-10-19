import { batchSupportsMultimodal, isLlmBatchProviderBroken, supportsLlmBatch, supportsNativeBatchDocuments } from '~/server/utils/extract/llm-batch'
import { readLlmExecutionMode } from '~/server/utils/app-settings'
import { readExtractionChainStrategy, readExtractionLlmConfigChain } from '~/server/utils/extract/llm-task-config'
import { type LlmConfig, type LlmInput } from '~/server/utils/extract/llm'
import { type RulesHint } from '~/server/utils/extract/llm-clamp'
import { isConnectionLostError, isLlmProviderError, isRateLimitError, isTransientRequestError } from '~/server/utils/extract/llm-errors'
import { waitForProviderRecovery } from '~/server/utils/extract/provider-recovery'
import { recordLlmUsage } from '~/server/utils/llm-usage'
import { createCandidateRecordLoader } from '~/server/utils/auction-record'
import { readArtifactProcessingState } from '~/server/utils/artifact-version-state'
import { readAuctionFetchStates, writeAuctionLlmClaim, writeAuctionLlmPipelineState } from '~/server/utils/auction-fetch-state'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { recordTaskRunError } from '~/server/utils/task-run-errors'
import { recordTaskRunProgress } from '~/server/utils/task-runs'
import { throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { runPool } from '~/server/utils/run-pool'
import { buildLlmRateLimitWarning, buildReprocessInput, buildRulesOnlyEntry, effectiveCandidateCountries, findCandidates, inputNeedsMultimodal, type Candidate, type ReprocessInput, type ReprocessOptions, type ReprocessResult } from './reprocess-input'
import { resolveLlmConcurrency, resolveMaxLlmPerRun } from './reprocess-budget'
import { persistReprocessEntry } from './reprocess-persist'
import { createReprocessProgress } from './reprocess-progress'
import { reprocessAuction } from './reprocess-single'
import { isReprocessEligible, rulesOnlyRebuildChangesEntry } from './reprocess-eligibility'
import { submitReprocessBatch } from './reprocess-batch-submit'

/** Transient provider errors (5xx, 408, no response) a run waits out before it
 *  gives up; see transientProviderErrors in runReprocess. */
const MAX_TRANSIENT_PROVIDER_ERRORS = 3

export async function runReprocess(opts: ReprocessOptions = {}, signal?: AbortSignal): Promise<ReprocessResult> {
  const startedAt = Date.now()
  if (opts.force && !opts.country && !opts.platform && !opts.externalId && !opts.caseNumber && !opts.limit) {
    throw new Error(
      '[reprocess] force requires country/platform/externalId/caseNumber or limit — an unbounded forced re-run would re-spend the LLM budget on every already-extracted auction',
    )
  }

  const candidateCountries = await effectiveCandidateCountries(opts)
  const rawCandidates = await findCandidates(opts, candidateCountries)
  const candidates = opts.preserveCandidateOrder ? rawCandidates : interleaveByPlatform(rawCandidates)
  if (candidates.length === 0) {
    const durationMs = Date.now() - startedAt
    console.log(`[reprocess] candidates=0 processed=0 skipped=0 llmCalls=0 in ${(durationMs / 1000).toFixed(0)}s`)
    return { candidates: 0, processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0, rulesFalsified: 0, durationMs }
  }
  // Per chunk of candidates, not the whole table (~350 MB held for the run's hour).
  const records = createCandidateRecordLoader(candidates)
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
  const maxLlmPerRun = await resolveMaxLlmPerRun()
  const concurrency = await resolveLlmConcurrency()
  const at = new Date().toISOString()
  const nowMs = new Date(at).getTime()
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
      `[reprocess] llm ${chainLabel} strategy=${chainStrategy} mode=${useBatch ? 'batch' : 'sync'} maxPerRun=${maxLlmPerRun} concurrency=${concurrency}`,
    )
  } else {
    console.log('[reprocess] llm disabled — rules-only')
  }

  // maxLlmPerRun is shared across all platforms; a per-platform cap keeps one
  // huge platform's backlog from burning through the whole budget before
  // smaller platforms' listings are ever reached (same rationale enrich.ts
  // used to apply — see interleave-by-platform.ts).
  const llmPlatformCount = new Set(candidates.map((c) => c.platform)).size || 1
  let llmCapPerPlatform = Math.max(1, Math.ceil(maxLlmPerRun / llmPlatformCount))
  // Candidates held back because their platform used up its fair share while
  // budget was still left; they get a second pass with the cap lifted.
  const candidateOrder = new Map(candidates.map((candidate, index) => [cacheKey(candidate.platform, candidate.externalId), index]))
  const deferred: { candidate: Candidate; order: number }[] = []
  const llmCallsByPlatform = new Map<string, number>()

  // Candidates run in parallel lanes (see runPool below): counters are bumped
  // where they happen — aggregate and per-country snapshot (for /settings)
  // together — instead of being diffed per iteration.
  const { totals, bump, progressByCountry } = createReprocessProgress(candidates)
  let rulesFalsified = 0
  let stopRun = false
  // A claude-proxy 502/503 or one timed-out prompt usually clears within
  // seconds, yet stopping at the first one cost the rest of the hour's budget.
  // Bounded, so a provider that keeps failing still ends the run.
  let transientProviderErrors = 0
  // LLM calls promised to candidates still in flight, so lanes started
  // together can't all pass the budget check against the same stale count.
  let llmReserved = 0
  const llmReservedByPlatform = new Map<string, number>()
  let lastLlmError: string | undefined
  let warning: string | undefined
  const batchItems: { key: string; input: LlmInput }[] = []
  const batchArtifactVersions = new Map<string, number | null>()
  const batchRulesHints = new Map<string, RulesHint | null>()

  // Distinguishes a persistEntry (DB write) failure from an LLM-call failure
  // in the catch block below — both land there, but they need different
  // task_run_errors categories (a storage outage isn't an LLM problem).
  const persistCtx = { runTrigger: opts.trigger ?? 'cron', at }
  const persistFailureMark = Symbol('persistFailure')
  function markPersistFailure(err: unknown): unknown {
    if (err instanceof Error) (err as Error & { [persistFailureMark]?: true })[persistFailureMark] = true
    return err
  }
  function isPersistFailure(err: unknown): boolean {
    return err instanceof Error && persistFailureMark in err
  }

  async function handleCandidate(candidate: Candidate): Promise<void> {
    const { platform, externalId, country } = candidate
    throwIfTaskAborted(signal)
    // Calls promised to this candidate but not yet started. Released one at a
    // time as onLlmAttempt increments llmCalls, or all at once in finally.
    let reservedCalls = 0
    function reserveLlmCalls(requested: number): number {
      const additional = requested - reservedCalls
      if (additional <= 0) return reservedCalls
      const platformReserved = llmReservedByPlatform.get(platform) ?? 0
      const available = opts.ignoreLlmBudget
        ? Infinity
        : Math.min(
          maxLlmPerRun - totals.llmCalls - llmReserved,
          llmCapPerPlatform - (llmCallsByPlatform.get(platform) ?? 0) - platformReserved,
        )
      const granted = Math.max(0, Math.min(additional, available))
      reservedCalls += granted
      llmReserved += granted
      llmReservedByPlatform.set(platform, platformReserved + granted)
      return reservedCalls
    }
    function releaseReservation(count = 1): void {
      const released = Math.min(count, reservedCalls)
      if (released === 0) return
      reservedCalls -= released
      llmReserved -= released
      llmReservedByPlatform.set(platform, (llmReservedByPlatform.get(platform) ?? released) - released)
    }
    // Hoisted out of the try block below so the catch can still see them: a
    // thrown rate-limit/unparseable-response error (see the catch's comment)
    // reaches onLlmAttempt before propagating past reprocessAuction, and the
    // cooldown timestamp needs recording even though this candidate never
    // reaches persistEntry.
    let syncLlmAttempted = false
    let priorLlmFailures = 0, lastLlmConfig: LlmConfig | null = null
    // Hoisted like syncLlmAttempted: whether writeAuctionLlmClaim ran, since
    // syncConfigs itself is scoped inside the try block below.
    let llmClaimed = false
    try {
      const key = cacheKey(platform, externalId)
      const record = await records.get(platform, externalId)
      if (!record) {
        bump(country, 'skipped')
        return
      }
      const storedPriorEntry = record.auction.extraction ?? undefined
      const priorState = fetchStates.get(key)
      const priorEntry = storedPriorEntry
      priorLlmFailures = priorState?.llmFailures ?? 0
      const artifactState = await readArtifactProcessingState(platform, externalId)
      if (!isReprocessEligible(opts, { priorEntry, priorState, artifactState, llmConfigured: llmConfig != null, nowMs })) {
        bump(country, 'skipped')
        return
      }

      const platformLlmCalls = llmCallsByPlatform.get(platform) ?? 0
      const budgetLeft = totals.llmCalls + llmReserved < maxLlmPerRun
      const platformRoom = platformLlmCalls + (llmReservedByPlatform.get(platform) ?? 0) < llmCapPerPlatform
      // The fair share is a first-pass limit, not a waste of budget: a capped
      // candidate waits for the second pass instead of going rules-only now.
      if (llmConfig && !opts.ignoreLlmBudget && !opts.force && budgetLeft && !platformRoom) {
        deferred.push({ candidate, order: candidateOrder.get(key) ?? Number.MAX_SAFE_INTEGER })
        return
      }
      const llmReady = !!llmConfig && (opts.ignoreLlmBudget || (budgetLeft && platformRoom))
      // Held until `finally`: from here to there other lanes see this
      // candidate's call as already spoken for. Taken in the same tick as the
      // check above, so two lanes can't both claim the last slot.
      if (llmReady) reserveLlmCalls(1)
      if (opts.force && llmConfig && !llmReady) {
        bump(country, 'skipped')
        return
      }
      // No LLM call this run (budget spent or no model): only a rules-only
      // rebuild is left. Skip the stored entries it cannot change instead of
      // re-reading their archive and rewriting them on every run.
      if (!llmReady && !opts.force && priorEntry && !rulesOnlyRebuildChangesEntry(record.auction, priorEntry)) {
        bump(country, 'skipped')
        return
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
          bump(country, 'skipped')
          return
        }
        // A candidate the configured batch provider can't take (OpenRouter's
        // Batch API rejects any image/document content outright — see
        // batchSupportsMultimodal) falls through to the synchronous path
        // below instead of being queued: submitting it would just skip it
        // into retryItems, and since that never sets an llmBatchJob marker,
        // it would stay eligible and get queued into the same doomed batch
        // again every run, forever.
        if (batchSupportsMultimodal(llmConfig) || !inputNeedsMultimodal(base.input)) {
          releaseReservation()
          bump(country, 'llmCalls')
          llmCallsByPlatform.set(platform, (llmCallsByPlatform.get(platform) ?? 0) + 1)
          batchItems.push({ key, input: base.input })
          batchArtifactVersions.set(key, base.artifactVersionId)
          batchRulesHints.set(key, base.input.rulesHint ?? null)
          // Keep the currently visible extraction intact while the replacement
          // is pending. The poller rebuilds a fresh merge base for changed sets.
          // A prior LLM result is kept too: a rules-only entry would replace its
          // structured values, and if the submission below fails or the run is
          // aborted first, nothing would ever restore them.
          const entry = priorEntry && (base.documentSetChanged || priorEntry.source === 'llm')
            ? priorEntry
            : buildRulesOnlyEntry(base.fields, priorEntry, at)
          bump(country, 'processed')
          // llmAttempted: false — queued, not yet submitted. The batch
          // submission loop below marks the real attempt once it actually
          // goes out (only some queued items may make it into submitted).
          await persistReprocessEntry(persistCtx, record, entry, artifactState.parsedArtifactVersionId, priorLlmFailures, base.auction, false)
            .catch((persistErr) => { throw markPersistFailure(persistErr) })
          return
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
        bump(country, 'skipped')
        stopRun = true
        return
      }

      // Claimed only for a real sync LLM call (not the rules-only fallback
      // below); cleared below, in the catch block, or by persistEntry's
      // writeAuctionLlmPipelineState. A fresh timestamp, not the shared `at`
      // above — that one is fixed at run start and would look stale already
      // for a candidate reached late in a long run.
      if (syncConfigs.length > 0) {
        llmClaimed = true
        await writeAuctionLlmClaim(platform, externalId, new Date().toISOString())
      }
      const result = await reprocessAuction(platform, externalId, priorEntry, syncConfigs[0] ?? null, at, {
        artifactState,
        priorLlmFailures,
        // Snapshot of what's actually left in this run's budget right now —
        // only meaningful to the map-reduce path (see reprocess-single.ts),
        // which needs to know its own hard ceiling before spending anything,
        // not just whether llmReady allowed a first call to start.
        remainingLlmBudget: opts.ignoreLlmBudget
          ? Infinity
          : Math.min(
            maxLlmPerRun - totals.llmCalls - (llmReserved - reservedCalls),
            llmCapPerPlatform - (llmCallsByPlatform.get(platform) ?? 0),
          ),
        reserveLlmCalls,
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
          releaseReservation()
          bump(country, 'llmCalls')
          llmCallsByPlatform.set(platform, (llmCallsByPlatform.get(platform) ?? 0) + 1)
        },
        onLlmError: (err) => {
          bump(country, 'llmErrors')
          const message = err instanceof Error ? err.message : String(err)
          lastLlmError = `${platform}:${externalId}: ${message}`
        },
        onLlmCall: async ({ config, durationMs, usage, status, errorMessage }) => {
          lastLlmConfig = config
          await recordLlmUsage({
            task: 'extraction',
            executionMode: 'sync',
            source: 'reprocess',
            provider: config.provider ?? 'openai-compatible',
            model: config.model,
            profileId: config.profileId ?? null,
            platform,
            externalId,
            usage,
            status,
            errorMessage,
            durationMs,
          })
        },
      })
      if (!result) {
        // buildReprocessInput bailed before persistEntry could clear the claim.
        if (llmClaimed) await writeAuctionLlmClaim(platform, externalId, null)
        bump(country, 'skipped')
        return
      }
      if (result.llmCalled && !syncLlmAttempted) {
        releaseReservation()
        bump(country, 'llmCalls')
        llmCallsByPlatform.set(platform, (llmCallsByPlatform.get(platform) ?? 0) + 1)
      }
      rulesFalsified += result.rulesFalsified.length

      bump(country, 'processed')

      // Persist each result immediately so a long run survives a deployment.
      await persistReprocessEntry(
        persistCtx, record, result.entry, result.artifactVersionId, result.llmFailures, result.auction, result.llmCalled || result.llmInputEmpty,
        result.llmConfigUsed, result.llmDurationMs, result.llmUsage,
      ).catch((persistErr) => { throw markPersistFailure(persistErr) })
    } catch (err) {
      // Also where a rate limit/quota error (see llm.ts's isRateLimitError())
      // lands: reprocessAuction/extractByLlm deliberately let it propagate
      // here instead of resolving to null, so the stored details stay untouched
      // — a capacity outage must never count toward llmFailures/
      // MAX_LLM_FAILURES, or it would permanently downgrade the auction to
      // rules-only once the limit is hit, long after the outage clears.
      console.warn(`[reprocess] failed for ${platform}:${externalId}: ${(err as Error).message}`)
      bump(country, 'skipped')
      // Unconditional (unlike the llmAttempted-gated write below): a throw
      // before onLlmAttempt fired would otherwise leave the claim stuck.
      if (llmClaimed) await writeAuctionLlmClaim(platform, externalId, null)
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
        // it so a locked-out auction's 24h cooldown (see reprocess-eligibility.ts)
        // actually advances instead of re-triggering every run forever.
        // llmFailures stays at its prior count: a capacity outage still must
        // never count toward MAX_LLM_FAILURES (see the comment above).
        await writeAuctionLlmPipelineState(platform, externalId, {
          llmBatchJob: null,
          llmArtifactVersionId: null,
          llmRulesHint: null,
          llmFailures: priorLlmFailures,
          llmAttempted: true,
        })
      }
      if (isRateLimitError(err)) {
        warning = buildLlmRateLimitWarning(err, llmConfig)
        console.warn('[reprocess] LLM provider rate-limited — stopping this run early')
        stopRun = true
        return
      }
      if (isLlmProviderError(err)) {
        // A restarted proxy drops every in-flight request at once. This
        // candidate is not re-sent (the proxy may already have accepted it, so
        // that could pay twice) — it stays open for the next run — but the run
        // itself carries on once the provider answers again.
        if (isConnectionLostError(err) && await waitForProviderRecovery(lastLlmConfig ?? llmConfig)) {
          console.warn('[reprocess] LLM provider connection was lost but it is back — continuing this run')
          return
        }
        // Same for a transient error status (5xx, 408) or no response at all;
        // 401/402/403 and other client errors still stop the run at once.
        const transient = isTransientRequestError(err.cause ?? err) && ++transientProviderErrors <= MAX_TRANSIENT_PROVIDER_ERRORS
        if (transient && await waitForProviderRecovery(lastLlmConfig ?? llmConfig)) {
          console.warn(`[reprocess] LLM provider error ${transientProviderErrors}/${MAX_TRANSIENT_PROVIDER_ERRORS} this run, provider answers again — continuing: ${err.message}`)
          return
        }
        warning = `LLM-Providerfehler: ${err.message}`
        console.warn('[reprocess] LLM provider unavailable — stopping this run early')
        stopRun = true
        return
      }
    } finally {
      releaseReservation(reservedCalls)
      void recordTaskRunProgress(
        'reprocess',
        { candidatesTotal: candidates.length, ...totals, rulesFalsified },
        { lastLlmError, progressByCountry: Object.fromEntries(progressByCountry) },
      )
    }
  }

  await runPool(candidates, concurrency, handleCandidate, () => stopRun)
  // Fair-share pass done: whatever budget the other platforms did not use goes
  // to the deferred candidates (alo is ~95 % of the bulgarian backlog but only
  // one platform among ~13). Each candidate is handled exactly once overall.
  if (deferred.length > 0 && !stopRun) {
    llmCapPerPlatform = Infinity
    console.log(`[reprocess] second pass: ${deferred.length} candidates deferred by the per-platform share, ${Math.max(0, maxLlmPerRun - totals.llmCalls)} calls left`)
    deferred.sort((a, b) => a.order - b.order)
    await runPool(deferred.map(({ candidate }) => candidate), concurrency, handleCandidate, () => stopRun)
  }
  // The per-country snapshot outlives the run in /settings, so its final
  // state has to get past the progress throttle — with a fast loop the last
  // in-loop reports above are routinely swallowed by it.
  await recordTaskRunProgress(
    'reprocess',
    { candidatesTotal: candidates.length, ...totals, rulesFalsified },
    { lastLlmError, progressByCountry: Object.fromEntries(progressByCountry), flush: true },
  )

  const batchWarning = await submitReprocessBatch(batchItems, llmConfig, {
    artifactVersions: batchArtifactVersions,
    rulesHints: batchRulesHints,
    fetchStates,
  })
  if (batchWarning) warning = warning ? `${warning} ${batchWarning}` : batchWarning

  const durationMs = Date.now() - startedAt
  console.log(
    `[reprocess] candidates=${candidates.length} processed=${totals.processed} skipped=${totals.skipped} llmCalls=${totals.llmCalls} llmErrors=${totals.llmErrors} rulesFalsified=${rulesFalsified} in ${(durationMs / 1000).toFixed(0)}s`,
  )
  return {
    candidates: candidates.length,
    ...totals,
    rulesFalsified,
    durationMs,
    ...(warning ? { warning } : {}),
    ...(lastLlmError ? { lastLlmError } : {}),
  }
}
