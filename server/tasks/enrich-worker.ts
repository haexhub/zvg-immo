import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import { crawlAll, ensureEnabledCountriesLoaded, listRegions, platforms } from '~/server/crawlers/registry'
import { ensureAuctionIdentity, upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { readAuctionRecordMap, type AuctionRecord } from '~/server/utils/auction-record'
import { applyAuctionExtraction } from '~/server/utils/auction-extraction'
import { mergeStoredAuction } from '~/server/utils/auction-merge'
import { readLatestArtifactVersions } from '~/server/utils/artifact-version-state'
import { readAuctionFetchStates, writeAuctionCrawlFetchState, writeAuctionEnrichClaim, writeAuctionPhotoPipelineState } from '~/server/utils/auction-fetch-state'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { matchAlerts } from '~/server/utils/alert-matching'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractDocumentPhotos } from '~/server/utils/extract/document-images'
import { prepareLiveLlmDocuments } from '~/server/utils/extract/llm-documents'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '~/server/utils/image-storage'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import {
  archiveAuction,
  archiveDocumentSet,
  archivePhotoBlob,
} from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { recordObservations } from '~/server/utils/history'
import { recordCrawlScope } from '~/server/utils/crawl-state'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'
import { normalizeAuctionDescription, normalizeAuctionDescriptions } from '~/server/utils/description-normalization'
import { recordTaskRunEnd, recordTaskRunProgress, recordTaskRunStart, type TaskRunSummary } from '~/server/utils/task-runs'
import { recordTaskRunError } from '~/server/utils/task-run-errors'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { fillAuctionGeocodes } from '~/server/utils/auction-geocoding'
import { loadScopedRetryResult, prepareEnrichWork } from './enrich-work-selection'
import { finalizeEnrichPersistence } from './enrich-persistence'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const ENRICH_CONCURRENCY = 8
// How many of this run's errors go into the single-line lastWarning preview
// (/settings). Every error is recorded in full in task_run_errors regardless
// of this limit — this only bounds the inline summary's length.
const WARNING_PREVIEW_LIMIT = 50
const CONTENT_HASH_IMAGE_FILE_RE = /^([0-9a-f]{8,32})\.(?:jpe?g|png|webp)$/i
function imageContentHashFromFilename(name: string): string | null {
  return CONTENT_HASH_IMAGE_FILE_RE.exec(name)?.[1] ?? null
}
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
    // Mirrors every runErrors entry into task_run_errors (Postgres) so it
    // survives past this run's lastWarning being overwritten by the next one,
    // and past a container restart — unlike a bare console.warn. Best-effort;
    // never blocks the run itself.
    function pushRunError(category: string, message: string, identity?: { platform?: string; externalId?: string }) {
      runErrors.push(message)
      void recordTaskRunError('enrich', { category, message, platform: identity?.platform, externalId: identity?.externalId })
    }
    // Scoped retry skips the live region crawl entirely — see
    // loadScopedRetryResult. `preloadedRecords` is reused below instead of
    // re-reading the same records map a second time.
    let preloadedRecords: Map<string, AuctionRecord> | undefined
    let result: Awaited<ReturnType<typeof crawlAll>>
    if (scopedRetry) {
      const scoped = await loadScopedRetryResult(opts.country, opts.identities!, capturedAt)
      result = scoped.result
      preloadedRecords = scoped.records
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
    const records = preloadedRecords ?? await readAuctionRecordMap(opts.country)
    const cachedGeocodes = await fillAuctionGeocodes(result.auctions, { fetchMissing: false })
    if (cachedGeocodes.geocoded > 0 || cachedGeocodes.failed > 0) {
      console.log(
        `[enrich] cached geocodes: processed=${cachedGeocodes.processed} hit=${cachedGeocodes.geocoded} failed=${cachedGeocodes.failed}`,
      )
    }
    const {
      byPlatform,
      rates,
      vwCache: initialVwCache,
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
      records,
    })
    let vwCache = initialVwCache
    console.log(`[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)archive`)
    todoTotalByCountry = new Map()
    for (const a of todo) todoTotalByCountry.set(a.country, (todoTotalByCountry.get(a.country) ?? 0) + 1)

    let archived = 0
    let enrichedCount = 0
    let photoExtractions = 0
    let photosTotal = 0
    const at = new Date().toISOString()
    const persistedDetails = new Map<string, { marketValueEur: number | null; marketValueText: string | null }>()
    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        throwIfTaskAborted(signal)
        const a = todo[cursor++]
        if (!a) continue
        // Fresh timestamp, not the shared `at` below (fixed at run start).
        await writeAuctionEnrichClaim(a.platform, a.externalId, new Date().toISOString())
        try {
          const crawler = byPlatform.get(a.platform)
          const key = cacheKey(a.platform, a.externalId)
          const priorRecord = records.get(key)
          const priorEntry = priorRecord?.auction.extraction ?? undefined

          // Detail fetch (description + attachments) so downstream document
          // archiving/photo mining has real data to work with. Stamp
          // detailFetchedAt when enrichOne returned without throwing — even if
          // the listing legitimately has no attachments/description — so we
          // don't re-fetch the same empty response on every future run.
          let enriched = false
          let fetchDone = !crawler?.enrichOne
          if (crawler?.enrichOne) {
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
              pushRunError('detail_fetch', `Detailabruf ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
            }
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
              deriveMarketValueEur(a, rates)
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
          if (needsDocumentSetCheck(a)) {
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

          // Photo pipeline — mirror native image URLs first, then mine every
          // document candidate. Native URLs stay in `auction.photoUrls` for
          // display; `extraction.photos` stores document-derived images only
          // after dropping exact byte duplicates whose content hash matches a
          // mirrored native image.
          let curatedPhotos: CuratedPhoto[] | undefined
          const priorFetchState = fetchStates.get(key)
          let photosCheckedAt = priorFetchState?.photosCheckedAt ?? null
          let photoFailures = priorFetchState?.photoFailures ?? 0
          let photoPipelineVersion = priorFetchState?.photoPipelineVersion ?? null
          const photoAttempted = needsPhotoBackfill(a) && isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)
          if (photoAttempted) {
            const destDir = join(IMAGES_DIR, a.platform, a.externalId)
            const priorPhotos = priorEntry?.photos?.map(normalizePhoto) ?? []
            const targetVersion = targetPhotoPipelineVersion(a)
            const rebuildingPhotoSet = (priorFetchState?.photoPipelineVersion ?? 1) < targetVersion
            let photos = rebuildingPhotoSet ? [] : priorPhotos.map((photo) => photo.file)
            let newlyDownloadedPhotos: string[] = []
            const nativeFotoUrls = nativePhotoUrls(a)
            const nativePhotoHashes = new Set<string>()
            const addNewlyDownloadedPhotos = (names: readonly string[]) => {
              newlyDownloadedPhotos = [...new Set([...newlyDownloadedPhotos, ...names])]
            }
            const addDisplayedPhotos = (names: readonly string[]) => {
              photos = [...new Set([...photos, ...names])]
            }
            // Native gallery download and document/PDF mining are independent
            // sources — each gets its own try/catch so one throwing (a
            // transient upstream problem) doesn't discard photos the other
            // already found, and doesn't skip the other source entirely.
            const sourceErrors: string[] = []
            if (nativeFotoUrls.length > 0) {
              try {
                const nativePhotos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
                addNewlyDownloadedPhotos(nativePhotos)
                addDisplayedPhotos(nativePhotos)
                for (const name of nativePhotos) {
                  const hash = imageContentHashFromFilename(name)
                  if (hash) nativePhotoHashes.add(hash)
                }
              } catch (err) {
                sourceErrors.push((err as Error).message)
              }
            }
            if (a.attachments.length > 0) {
              photoExtractions++
              try {
                const documentPhotos = await extractDocumentPhotos(a.attachments, {
                  destDir,
                })
                addNewlyDownloadedPhotos(documentPhotos)
                addDisplayedPhotos(
                  documentPhotos.filter((name) => {
                    const hash = imageContentHashFromFilename(name)
                    return !hash || !nativePhotoHashes.has(hash)
                  }),
                )
              } catch (err) {
                sourceErrors.push((err as Error).message)
              }
            }
            photosTotal += photos.length
            try {
              // Archive every freshly downloaded photo's raw bytes (kind='photo')
              // and mirror it into the images bucket (WP-4) when configured, so
              // /api/auction-image can fall back to Supabase once the local cache
              // is gone. uploadImage never throws and no-ops without a configured
              // bucket.
              for (const name of [...new Set(newlyDownloadedPhotos)]) {
                const bytes = await readFile(join(destDir, name))
                await archivePhotoBlob(bytes, mimeTypeFor(name) as any, documentIdentity, at)
                if (imagesBucketConfigured()) await uploadImage(bytes, `${a.platform}/${a.externalId}/${name}`)
              }
            } catch (err) {
              sourceErrors.push((err as Error).message)
            }
            if (sourceErrors.length > 0) {
              photoFailures++
              pushRunError('photo_extraction', `Fotoextraktion ${a.platform}:${a.externalId}: ${sourceErrors.join('; ')}`, a)
              if (photos.length === 0 && priorPhotos.length > 0) {
                photos = priorPhotos.map((photo) => photo.file)
              }
            } else {
              // Completed without throwing — "checked", regardless of whether
              // any photos were actually found (a legitimately photo-less
              // listing/document stops being retried from here on).
              photosCheckedAt = at
              photoFailures = 0
              photoPipelineVersion = targetPhotoPipelineVersion(a)
            }
            curatedPhotos = photos.length > 0
              ? photos.map((name) => priorPhotos.find((photo) => photo.file === name) ?? normalizePhoto(name))
              : undefined
          } else {
            curatedPhotos = priorEntry?.photos?.map(normalizePhoto)
          }

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
          await writeAuctionPhotoPipelineState(a.platform, a.externalId, {
            photosCheckedAt,
            photoFailures,
            photoPipelineVersion,
            photoAttempted,
          })
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
            await writeAuctionDetails(a, entry, { artifactVersionId: priorRecord?.artifactVersionId ?? null })
            persistedDetails.set(key, {
              marketValueEur: a.marketValueEur,
              marketValueText: a.marketValueText,
            })
            await upsertCurrentAuctions([a], at)
          } catch (err) {
            pushRunError('auction_details', `Details ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
          }
        } finally { await writeAuctionEnrichClaim(a.platform, a.externalId, null) }
        archived++
        archivedByCountry.set(a.country, (archivedByCountry.get(a.country) ?? 0) + 1)
        void recordTaskRunProgress(
          'enrich',
          { regionsDone, regionsTotal, archivedDone: archived, archivedTotal: todo.length },
          { progressByCountry: snapshotProgressByCountry() },
        )
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))
    // The per-country snapshot outlives the run in /settings, so its final
    // state has to get past the progress throttle — the last few in-loop
    // reports above are routinely swallowed by it.
    await recordTaskRunProgress(
      'enrich',
      { regionsDone, regionsTotal, archivedDone: archived, archivedTotal: todo.length },
      { progressByCountry: snapshotProgressByCountry(), flush: true },
    )

    // Country-wide bookkeeping (stale-listing cleanup, history snapshot) only
    // makes sense against a real crawl result — a scoped retry's worker loop
    // above already persisted everything its identities need.
    if (!scopedRetry) {
      await finalizeEnrichPersistence({
        result,
        records,
        persistedDetails,
        capturedAt,
        at,
        pushRunError,
        signal,
      })
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} todo=${todo.length} archived=${archived} enriched=${enrichedCount} photos=${photosTotal}/${photoExtractions}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        todo: todo.length,
        archived,
        enriched: enrichedCount,
        photoExtractions,
        photosTotal,
        failed: runErrors.length,
        durationMs,
      },
      warning: runErrors.length > 0
        ? `${runErrors.length} Fehler: ${runErrors.slice(0, WARNING_PREVIEW_LIMIT).join('; ')}`
        : undefined,
    }
}
