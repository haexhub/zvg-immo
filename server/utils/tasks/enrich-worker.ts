import type { AuctionExtraction } from '~/types/auction'
import { crawlAll, ensureEnabledCountriesLoaded, listRegions, platforms } from '~/server/crawlers/registry'
import { ensureAuctionIdentity, upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { readAuctionRecord } from '~/server/utils/auction-record'
import { applyAuctionExtraction } from '~/server/utils/auction-extraction'
import { mergeStoredAuction } from '~/server/utils/auction-merge'
import { readLatestArtifactVersions } from '~/server/utils/artifact-version-state'
import { readAuctionFetchStates, writeAuctionCrawlFetchState, writeAuctionEnrichClaim, writeAuctionPhotoPipelineState } from '~/server/utils/auction-fetch-state'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { matchAlerts } from '~/server/utils/alert-matching'
import { prepareLiveLlmDocuments } from '~/server/utils/extract/llm-documents-live'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { archiveAuction, archiveDocumentSet } from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { recordObservations } from '~/server/utils/history'
import { recordCrawlScope } from '~/server/utils/crawl-state'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'
import { normalizeAuctionDescription, normalizeAuctionDescriptions } from '~/server/utils/description-normalization'
import { recordTaskRunEnd, recordTaskRunProgress, recordTaskRunStart, type TaskRunSummary } from '~/server/utils/task-runs'
import { recordTaskRunError } from '~/server/utils/task-run-errors'
import { isSourceRateLimited } from '~/server/utils/source-rate-limit'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { fillAuctionGeocodes } from '~/server/utils/auction-geocoding'
import { loadScopedRetryResult, prepareEnrichWork, readStoredAuctionSummaries, type StoredAuctionSummary } from './enrich-work-selection'
import { finalizeEnrichPersistence } from './enrich-persistence'
import { processEnrichPhotos } from './enrich-photos'

const ENRICH_CONCURRENCY = 8
// How many of this run's errors go into the single-line lastWarning preview
// (/settings). Every error is recorded in full in task_run_errors regardless
// of this limit — this only bounds the inline summary's length.
const WARNING_PREVIEW_LIMIT = 50
// Guards against overlapping runs: a cold-start bootstrap run (many detail
// fetches + document downloads) can still be active when the cron tick
// fires. Two concurrent runs would double-fetch details and race on the
// snapshot write.
export interface EnrichOptions {
  /** Distinguishes explicit admin requests from scheduled/boot work. */
  trigger?: 'cron' | 'manual'
  /** ISO-3166-1 alpha-2, lowercase. Omit to crawl every enabled country. */
  country?: string
  /** Revisit every crawled listing in scope, regardless of existing cache markers. */
  force?: boolean
  /** Persist each regional crawl into the serving list cache while archiving. */
  recordCrawlScope?: boolean
  /** Skip the live region crawl and (re)archive exactly these already-known
   *  auctions instead — the crawl-status card's single-auction and
   *  open/failed bulk retry triggers. Every listed identity is always
   *  processed regardless of existing cache markers (acts like `force`, just
   *  scoped to these); finalizeEnrichPersistence's country-wide bookkeeping
   *  (stale-listing cleanup, history snapshot) is skipped since there was no
   *  live crawl backing it — the per-auction worker loop below already
   *  persists everything these identities need. */
  identities?: { platform: string; externalId: string }[]
}
/** Crawls, selects, enriches, and persists the auctions in one enrich run. */
export async function runEnrich(opts: EnrichOptions = {}, signal?: AbortSignal) {
    const startedAt = Date.now()
    const capturedAt = new Date(startedAt).toISOString()
    const scopedRetry = (opts.identities?.length ?? 0) > 0
    console.log(`[enrich] start${opts.country ? ` (country=${opts.country})` : ''}${opts.force ? ' force=true' : ''}${scopedRetry ? ` identities=${opts.identities!.length}` : ''}`)

    let regionsDone = 0
    let regionsTotal = 0
    // Per-country breakdown of the same two phases (region crawl, then
    // per-auction archive) for /settings — regionsByCountry's totals are
    // seeded upfront from the same scope crawlAll() will use, so a country
    // shows up (at 0/N) as soon as the run starts rather than only once its
    // first region finishes.
    const regionsByCountry = new Map<string, { done: number; total: number }>()
    // crawlAll() hydrates the enabled-country set from Postgres itself before
    // it reads listRegions(); this seed runs first, so without the same await
    // a cold process would seed from the compiled-in defaults and list
    // countries the admin has paused (stuck at 0/N forever).
    await ensureEnabledCountriesLoaded()
    for (const r of listRegions()) {
      if (opts.country && r.country !== opts.country.toLowerCase()) continue
      const entry = regionsByCountry.get(r.country) ?? { done: 0, total: 0 }
      entry.total++
      regionsByCountry.set(r.country, entry)
    }
    const archivedByCountry = new Map<string, number>()
    let todoTotalByCountry = new Map<string, number>()
    function snapshotProgressByCountry(): Record<string, TaskRunSummary> {
      const countries = new Set([...regionsByCountry.keys(), ...todoTotalByCountry.keys()])
      const out: Record<string, TaskRunSummary> = {}
      for (const country of countries) {
        const regions = regionsByCountry.get(country)
        out[country] = {
          regionsDone: regions?.done ?? 0,
          regionsTotal: regions?.total ?? 0,
          archivedDone: archivedByCountry.get(country) ?? 0,
          archivedTotal: todoTotalByCountry.get(country) ?? 0,
        }
      }
      return out
    }
    const runErrors: string[] = []
    // Auctions with at least one error this run — one auction can collect
    // several (detail fetch, document archive, photos), so runErrors.length
    // over-counts failed auctions.
    const failedAuctions = new Set<string>()
    // Mirrors every runErrors entry into task_run_errors (Postgres) so it
    // survives past this run's lastWarning being overwritten by the next one,
    // and past a container restart — unlike a bare console.warn. Best-effort;
    // never blocks the run itself.
    function pushRunError(category: string, message: string, identity?: { platform?: string; externalId?: string }) {
      runErrors.push(message)
      if (identity?.platform && identity.externalId) failedAuctions.add(cacheKey(identity.platform, identity.externalId))
      void recordTaskRunError('enrich', { category, message, platform: identity?.platform, externalId: identity?.externalId })
    }
    // Platforms whose source is rate-limiting us (see source-rate-limit.ts):
    // their remaining detail fetches are skipped for this run — one run error
    // instead of one per auction — and stay 'open' for the next one.
    const rateLimitedPlatforms = new Set<string>()
    // Scoped retry skips the live region crawl entirely — see
    // loadScopedRetryResult. `preloadedSummaries` is reused below instead of
    // reading the stored summaries a second time.
    let preloadedSummaries: Map<string, StoredAuctionSummary> | undefined
    let result: Awaited<ReturnType<typeof crawlAll>>
    if (scopedRetry) {
      const scoped = await loadScopedRetryResult(opts.identities!, capturedAt)
      result = scoped.result
      preloadedSummaries = scoped.summaries
    } else {
      result = await crawlAll({
        immobilienOnly: true,
        enrichDetails: false,
        country: opts.country,
        signal,
        onRegionResult: opts.recordCrawlScope
          ? async (country, region, regionResult) => {
            await matchAlerts(country, region, regionResult)
            // Identity must exist before any archive write — archiveAuction's
            // artifact_captures row has an FK on (platform, external_id).
            await ensureAuctionIdentity(regionResult.auctions)
            await recordCrawlScope(country, region, regionResult, capturedAt)
            await writeAuctionCrawlFetchState(regionResult.auctions)
            for (const auction of regionResult.auctions) {
              throwIfTaskAborted(signal)
              await archiveAuction(auction, capturedAt)
            }
          }
          : undefined,
        onRegionDone: (done, total, last) => {
          regionsDone = done
          regionsTotal = total
          const entry = regionsByCountry.get(last.country) ?? { done: 0, total: 0 }
          entry.done++
          regionsByCountry.set(last.country, entry)
          void recordTaskRunProgress(
            'enrich',
            { regionsDone, regionsTotal, archivedDone: 0, archivedTotal: 0 },
            { progressByCountry: snapshotProgressByCountry() },
          )
        },
      })
    }
    // Identity must exist before this task's own tail loop below archives
    // detail data (archiveAuction's artifact_captures row has an FK on
    // (platform, external_id)) — refresh.ts/country-rebuild.ts already do
    // this for their own writes, but enrich's crawlAll() call is independent
    // of those and can discover auctions before either has run.
    await ensureAuctionIdentity(result.auctions)
    await writeAuctionCrawlFetchState(result.auctions)
    const fetchStates = await readAuctionFetchStates()
    const artifactVersions = await readLatestArtifactVersions()
    const stored = preloadedSummaries ?? await readStoredAuctionSummaries(opts.country)
    const cachedGeocodes = await fillAuctionGeocodes(result.auctions, { fetchMissing: false })
    if (cachedGeocodes.geocoded > 0 || cachedGeocodes.failed > 0) {
      console.log(
        `[enrich] cached geocodes: processed=${cachedGeocodes.processed} hit=${cachedGeocodes.geocoded} failed=${cachedGeocodes.failed}`,
      )
    }
    const {
      byPlatform,
      rates,
      vwCache: initialVwCache, scopedForce,
      needsEnrich,
      needsDocumentSetCheck,
      nativePhotoUrls,
      targetPhotoPipelineVersion,
      needsPhotoBackfill,
      todo,
    } = await prepareEnrichWork({
      opts,
      auctions: result.auctions,
      fetchStates,
      artifactVersions,
      stored,
    })
    let vwCache = initialVwCache
    console.log(`[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)archive`)
    todoTotalByCountry = new Map()
    for (const a of todo) todoTotalByCountry.set(a.country, (todoTotalByCountry.get(a.country) ?? 0) + 1)

    let processed = 0
    let archived = 0
    // Left for a later run because their platform is rate-limiting this one.
    let deferred = 0
    let enrichedCount = 0
    let photoExtractions = 0
    let photosTotal = 0
    const at = new Date().toISOString()
    const persistedDetails = new Map<string, { marketValueEur: number | null; marketValueText: string | null }>()
    // Progress counts every item that left the loop, deferred ones included,
    // so the per-country bars still reach their todo totals.
    function reportItemDone(a: (typeof todo)[number]) {
      processed++
      archivedByCountry.set(a.country, (archivedByCountry.get(a.country) ?? 0) + 1)
      void recordTaskRunProgress(
        'enrich',
        { regionsDone, regionsTotal, archivedDone: processed, archivedTotal: todo.length },
        { progressByCountry: snapshotProgressByCountry() },
      )
    }
    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        throwIfTaskAborted(signal)
        const a = todo[cursor++]
        if (!a) continue
        // An item that is only due for its detail fetch has nothing else to
        // do while its source rate-limits us: skip it before the claim and
        // every per-item read/write below (alo.bg alone leaves ~34k such
        // listings per run). Items whose detail data already exists still run
        // their document/photo steps from the stored payload — those go
        // through the generic downloaders, not the throttled detail-page host.
        if (rateLimitedPlatforms.has(a.platform) && needsEnrich(a)) {
          deferred++
          reportItemDone(a)
          continue
        }
        // Every per-item failure (including the claim/state writes) is caught
        // here: a rejected worker would fail Promise.all below and release the
        // task lock while its sibling workers kept crawling, letting a new run
        // start alongside them. Only an abort escapes (see allSettled below).
        try {
          // Fresh timestamp, not the shared `at` below (fixed at run start).
          await writeAuctionEnrichClaim(a.platform, a.externalId, new Date().toISOString())
          const crawler = byPlatform.get(a.platform)
          const key = cacheKey(a.platform, a.externalId)

          // Detail fetch (description + attachments) so downstream document
          // archiving/photo mining has real data to work with. Stamp
          // detailFetchedAt when enrichOne returned without throwing — even if
          // the listing legitimately has no attachments/description — so we
          // don't re-fetch the same empty response on every future run.
          let enriched = false
          let fetchDone = !crawler?.enrichOne
          if (crawler?.enrichOne && !rateLimitedPlatforms.has(a.platform)) {
            try {
              await crawler.enrichOne(a)
              fetchDone = true
              // Any enrichOne-populated field counts — some platforms yield only
              // structured values or a photo gallery, no description/attachments.
              enriched =
                a.description != null ||
                a.attachments.length > 0 ||
                a.sourceLivingAreaSqm != null ||
                a.sourceLandAreaSqm != null ||
                a.sourceRooms != null ||
                (a.photoUrls?.length ?? 0) > 0 ||
                a.lat != null
            } catch (err) {
              if (isSourceRateLimited(err)) {
                if (!rateLimitedPlatforms.has(a.platform)) {
                  rateLimitedPlatforms.add(a.platform)
                  pushRunError('detail_fetch', `Detailabrufe ${a.platform} pausiert (Rate-Limit): ${err.message}`, { platform: a.platform })
                }
              } else {
                pushRunError('detail_fetch', `Detailabruf ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
              }
            }
          }
          // Same as the pre-claim skip above, for the lanes that were already
          // in flight when the rate limit surfaced. The finally below still
          // releases the claim.
          if (!fetchDone && rateLimitedPlatforms.has(a.platform) && needsEnrich(a)) {
            deferred++
            reportItemDone(a)
            continue
          }
          // Runs regardless of whether this platform has its own enrichOne step
          // — a crawler without one (e.g. se-kronofogden) already returns the
          // final description/market-value data straight from the list crawl,
          // so these must not be skipped just because there was no separate
          // fetch to wait for.
          if (fetchDone) {
            try {
              normalizeAuctionDescription(a)
              applyDescriptionMarketValue(a)
              // The live record is only re-read further down (photo/extraction
              // step); the run-start snapshot is enough to keep a stored EUR
              // conversion of the same native amount.
              deriveMarketValueEur(a, rates, stored.get(key)?.marketValue)
              a.detailFetchedAt = at
              // Re-archive now that detail data (description/attachments/
              // source*) is on the auction — a new content hash whenever
              // enrichment actually added something (see raw-archive.ts).
              await archiveAuction(a, at)
            } catch (err) {
              a.detailFetchedAt = undefined
              pushRunError('raw_archive', `Roharchiv ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
            }
          }
          if (enriched) enrichedCount++

          // A platform with a detail step only learns its attachments and photo
          // gallery from it — its list crawl leaves them empty. Running the
          // document/photo steps on that list shape would archive an empty
          // document set and mark an empty gallery as checked, after which the
          // next successful detail fetch is never archived or mined. When only
          // this run's fetch failed, an earlier one's stored payload stands in.
          const prevState = fetchStates.get(key)
          const hasDetailData = fetchDone || prevState?.detailFetchedAt != null
          if (!fetchDone && prevState?.detailFetchedAt != null) {
            if (a.attachments.length === 0) a.attachments = prevState.attachments
            if (!a.photoUrls?.length && prevState.photoUrls?.length) a.photoUrls = prevState.photoUrls
          }

          const documentIdentity = {
            platform: a.platform,
            country: a.country,
            region: a.region,
            externalId: a.externalId,
            caseNumber: a.caseNumber,
            authority: a.authority,
          }

          // Document archiving: download every candidate attachment and store
          // its bytes (artifact_versions/artifact_version_items + artifact_blobs).
          // Only the archived bytes matter here — reprocess.ts re-reads and
          // parses them independently, so this task never needs to keep the
          // parsed text/pages around.
          if (hasDetailData && needsDocumentSetCheck(a)) {
            const preparedDocuments = await prepareLiveLlmDocuments(a.attachments, documentIdentity, at)
            if (!preparedDocuments.documentSetComplete) {
              if (a.attachments.length > 0) {
                const detail = preparedDocuments.errors?.length ? `: ${preparedDocuments.errors.join('; ')}` : ''
                pushRunError('document_archive_incomplete', `Dokumentarchiv ${a.platform}:${a.externalId} ist unvollständig${detail}`, a)
              }
            } else {
              const archivedSet = await archiveDocumentSet(documentIdentity, preparedDocuments.documentSetItems, at)
              if (!archivedSet && a.attachments.length > 0) {
                pushRunError('document_manifest_write_failed', `Dokumentmanifest ${a.platform}:${a.externalId} konnte nicht gespeichert werden`, a)
              }
            }
          }

          // Re-read the live row instead of trusting the run-start summaries in
          // `stored`: by now it can be hours old, and reprocess/llm-batch-poll
          // may have stored a newer (LLM) extraction that writing the snapshot
          // back below would silently roll back.
          const priorRecord = await readAuctionRecord(a.platform, a.externalId)
          const priorEntry = priorRecord?.auction.extraction ?? undefined

          // Photo pipeline — see enrich-photos.ts.
          const photoOutcome = await processEnrichPhotos(a, priorEntry, prevState, documentIdentity, {
            at,
            scopedForce,
            needsPhotoBackfill: (auction) => hasDetailData && needsPhotoBackfill(auction),
            nativePhotoUrls,
            targetPhotoPipelineVersion,
          })
          if (photoOutcome.minedDocuments) photoExtractions++
          photosTotal += photoOutcome.photoCount
          if (photoOutcome.error) {
            pushRunError('photo_extraction', `Fotoextraktion ${a.platform}:${a.externalId}: ${photoOutcome.error}`, a)
          }
          const curatedPhotos = photoOutcome.curatedPhotos

          // Carry extraction-owned facts forward while updating only photo output.
          const entry: AuctionExtraction = priorEntry
            ? {
                ...priorEntry,
                photos: curatedPhotos,
              }
            : {
                // Placeholder extraction-owned fields for a brand-new auction —
                // "never parsed yet", matching reprocess.ts's own eligibility
                // check for an absent/low-confidence entry.
                propertyType: null,
                landAreaSqm: null,
                livingAreaSqm: null,
                rooms: null,
                units: null,
                source: 'rules',
                confidence: 'low',
                at,
                photos: curatedPhotos,
              }
          a.extraction = entry
          await writeAuctionCrawlFetchState([a])
          // Make this auction visible right away instead of waiting for the
          // whole run to finish — otherwise a freshly activated country shows
          // nothing in /search until every listing has been processed.
          try {
            if (a.marketValueEur == null) {
              const vwHit = vwCache[cacheKey(a.platform, a.externalId)]
              if (vwHit) {
                a.marketValueEur = vwHit.marketValueEur
                a.marketValueText = vwHit.marketValueText
              }
            }
            if (a.detailFetchedAt == null && priorRecord) mergeStoredAuction(a, priorRecord.auction)
            applyAuctionExtraction(a, entry)
            await writeAuctionDetails(a, entry, { artifactVersionId: priorRecord?.artifactVersionId ?? null, ownsPhotoSet: true })
            // Only mark the photo set checked once it is actually stored:
            // finalize re-reads the record and would otherwise drop these
            // photos for good, with no backfill left to recover them.
            await writeAuctionPhotoPipelineState(a.platform, a.externalId, photoOutcome.photoState)
            persistedDetails.set(key, {
              marketValueEur: a.marketValueEur,
              marketValueText: a.marketValueText,
            })
            await upsertCurrentAuctions([a], at)
          } catch (err) {
            pushRunError('auction_details', `Details ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
          }
        } catch (err) {
          throwIfTaskAborted(signal)
          pushRunError('enrich_item', `Enrich ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
        } finally {
          try {
            await writeAuctionEnrichClaim(a.platform, a.externalId, null)
          } catch (err) {
            pushRunError('enrich_claim', `Enrich-Claim ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
          }
        }
        if (!failedAuctions.has(cacheKey(a.platform, a.externalId))) archived++
        reportItemDone(a)
      }
    }
    // allSettled, not all: an aborted worker must not release the task lock
    // while its siblings still finish their in-flight item (detail fetch,
    // downloads, claim release) and would write alongside the next run.
    const settled = await Promise.allSettled(Array.from({ length: ENRICH_CONCURRENCY }, worker))
    const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (rejected) throw rejected.reason
    // The per-country snapshot outlives the run in /settings, so its final
    // state has to get past the progress throttle — the last few in-loop
    // reports above are routinely swallowed by it.
    await recordTaskRunProgress(
      'enrich',
      { regionsDone, regionsTotal, archivedDone: processed, archivedTotal: todo.length },
      { progressByCountry: snapshotProgressByCountry(), flush: true },
    )

    // Country-wide bookkeeping (stale-listing cleanup, history snapshot) only
    // makes sense against a real crawl result — a scoped retry's worker loop
    // above already persisted everything its identities need.
    if (!scopedRetry) {
      await finalizeEnrichPersistence({
        result,
        country: opts.country,
        persistedDetails,
        capturedAt,
        at,
        pushRunError,
        signal,
      })
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} todo=${todo.length} archived=${archived} deferred=${deferred} failed=${failedAuctions.size} enriched=${enrichedCount} photos=${photosTotal}/${photoExtractions}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        todo: todo.length,
        archived,
        deferred,
        enriched: enrichedCount,
        photoExtractions,
        photosTotal,
        failed: failedAuctions.size,
        errors: runErrors.length,
        durationMs,
      },
      warning: runErrors.length > 0
        ? `${runErrors.length} Fehler: ${runErrors.slice(0, WARNING_PREVIEW_LIMIT).join('; ')}`
        : undefined,
    }
}
