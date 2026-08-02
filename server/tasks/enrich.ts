// Crawls every registered region, fetches each new/changed listing's detail
// page, and downloads + archives its documents and photos (Postgres +
// Supabase Storage, see raw-archive.ts). This task is deliberately just the
// crawl/archive half of the pipeline — it never runs regex rules or calls an
// LLM, so it keeps discovering new listings and archiving changed documents
// even when the LLM is unavailable, rate-limited, or out of token budget.
//
// Extraction (rules + LLM) is a fully separate task (server/tasks/reprocess.ts)
// on its own schedule. The two tasks never call each other; they only
// communicate through the shared extraction_cache row for each auction:
// this task owns and writes `photos`/`photosCheckedAt`/`photoFailures`/
// `photoPipelineVersion`/`archivedDocumentSetHash`/`archivedDocumentSetVersion`,
// carrying every other (extraction-owned) field forward unchanged.
// reprocess.ts owns the rest and decides what needs (re)parsing by comparing
// `archivedDocumentSetHash` (what this task last archived) against
// `documentSetHash` (what reprocess.ts last actually parsed).
//
// Detail fetching: the list crawl is cheap (one request per region), but the
// real text/attachments live on each auction's detail page. So instead of
// re-fetching every listing on every run (which would hammer the upstream
// portals — BOE in particular has captcha cooldowns), we call the crawler's
// enrichOne() only for auctions not yet marked as detail-fetched. Each
// auction's detail is therefore fetched at most once, ever (until the source
// signals an update via sourceUpdatedIso).
//
// Triggered by the scheduled task config in nuxt.config.ts and once shortly
// after server startup via server/plugins/enrich-bootstrap.ts.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import { crawlAll, platforms } from '~/server/crawlers/registry'
import { readAuctionSnapshot, writeAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { ensureAuctionIdentity, upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { matchAlerts } from '~/server/utils/alert-matching'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractDocumentPhotos } from '~/server/utils/extract/document-images'
import { prepareLiveLlmDocuments } from '~/server/utils/extract/llm-documents'
import {
  applyExtractionToAuctions,
  type ExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from '~/server/utils/extraction-cache'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '~/server/utils/image-storage'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import {
  archiveAuction,
  archiveDocumentSet,
  archivePhotoBlob,
  type ArchivedDocumentSetResult,
} from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { recordObservations } from '~/server/utils/history'
import { writeListCache } from '~/server/utils/list-cache'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'
import { normalizeAuctionDescription, normalizeAuctionDescriptions } from '~/server/utils/description-normalization'
import { recordTaskRunEnd, recordTaskRunProgress, recordTaskRunStart } from '~/server/utils/task-runs'
import { recordTaskRunError } from '~/server/utils/task-run-errors'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const ENRICH_CONCURRENCY = 8
const FLUSH_EVERY = 200
// How many of this run's errors go into the single-line lastWarning preview
// (/settings). Every error is recorded in full in task_run_errors regardless
// of this limit — this only bounds the inline summary's length.
const WARNING_PREVIEW_LIMIT = 50
// Give up retrying a listing whose photo pipeline (native download / document
// extraction) keeps *throwing* after this many attempts. A listing that
// completes an attempt but legitimately has no usable photos stops retrying
// immediately (photosCheckedAt gets set); this bound only guards against
// persistent errors.
const MAX_PHOTO_FAILURES = 3
const PHOTO_PIPELINE_VERSION = 4
const KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION = 5
const CONTENT_HASH_IMAGE_FILE_RE = /^([0-9a-f]{8,32})\.(?:jpe?g|png|webp)$/i

function imageContentHashFromFilename(name: string): string | null {
  return CONTENT_HASH_IMAGE_FILE_RE.exec(name)?.[1] ?? null
}

// Guards against overlapping runs: a cold-start bootstrap run (many detail
// fetches + document downloads) can still be active when the cron tick
// fires. Two concurrent runs would double-fetch details and race on the
// snapshot write.
export interface EnrichOptions {
  /** ISO-3166-1 alpha-2, lowercase. Omit to crawl every enabled country. */
  country?: string
  /** Revisit every crawled listing in scope, regardless of existing cache markers. */
  force?: boolean
  /** Persist each regional crawl into the serving list cache while archiving. */
  writeListCache?: boolean
}

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions, fetch detail pages, and download/archive documents + photos. No extraction — see the reprocess task.',
  },
  async run(event) {
    return await runExclusiveTask('enrich', async (signal) => {
      await recordTaskRunStart('enrich')
      try {
        const outcome = await runEnrich((event?.payload ?? {}) as EnrichOptions, signal)
        await recordTaskRunEnd('enrich', { result: outcome.result, warning: outcome.warning })
        return outcome
      } catch (err) {
        await recordTaskRunEnd('enrich', { error: (err as Error).message })
        throw err
      }
    })
  },
})

export async function runEnrich(opts: EnrichOptions = {}, signal?: AbortSignal) {
    const startedAt = Date.now()
    const capturedAt = new Date(startedAt).toISOString()
    console.log(`[enrich] start${opts.country ? ` (country=${opts.country})` : ''}${opts.force ? ' force=true' : ''}`)

    let regionsDone = 0
    let regionsTotal = 0
    const runErrors: string[] = []
    // Mirrors every runErrors entry into task_run_errors (Postgres) so it
    // survives past this run's lastWarning being overwritten by the next one,
    // and past a container restart — unlike a bare console.warn. Best-effort;
    // never blocks the run itself.
    function pushRunError(category: string, message: string, identity?: { platform?: string; externalId?: string }) {
      runErrors.push(message)
      void recordTaskRunError('enrich', { category, message, platform: identity?.platform, externalId: identity?.externalId })
    }
    const result = await crawlAll({
      immobilienOnly: true,
      enrichDetails: false,
      country: opts.country,
      signal,
      onRegionResult: opts.writeListCache
          ? async (country, region, regionResult) => {
            await writeListCache(country, region, regionResult)
            await matchAlerts(country, region, regionResult)
            // Identity must exist before any archive write — archiveAuction's
            // artifact_captures row has an FK on (platform, external_id).
            await ensureAuctionIdentity(regionResult.auctions)
            for (const auction of regionResult.auctions) {
              throwIfTaskAborted(signal)
              await archiveAuction(auction, capturedAt)
            }
          }
        : undefined,
      onRegionDone: (done, total) => {
        regionsDone = done
        regionsTotal = total
        void recordTaskRunProgress('enrich', { regionsDone, regionsTotal, archivedDone: 0, archivedTotal: 0 })
      },
    })
    // Identity must exist before this task's own tail loop below archives
    // detail data (archiveAuction's artifact_captures row has an FK on
    // (platform, external_id)) — refresh.ts/country-rebuild.ts already do
    // this for their own writes, but enrich's crawlAll() call is independent
    // of those and can discover auctions before either has run.
    await ensureAuctionIdentity(result.auctions)
    const cache = await readExtractionCache()
    const previousSnapshot = await readAuctionSnapshot()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const rates = await getRates()
    // Re-read below, right before the tail loop: geocode runs 30 min before
    // enrich (see nuxt.config.ts) but can still be writing this cache while
    // enrich's own crawl+worker phase is in flight, so a stale snapshot taken
    // here would miss Verkehrswerte that "just arrived" mid-run.
    let vwCache = await readVerkehrswertCache()

    // Two independent reasons to (re)fetch detail: no detail fetch recorded
    // yet, OR the previous snapshot never recorded one (`detailFetchedAt`
    // absent) — meaning enrichOne either never ran or ran before the marker
    // existed and is due for a one-shot backfill. Once the marker is set, the
    // listing drops out of the todo list even if it legitimately has no
    // attachments/description (which would otherwise cause endless retries).
    const needsEnrich = (a: Auction): boolean => {
      const crawler = byPlatform.get(a.platform)
      if (!crawler?.enrichOne) return false
      const prev = previousSnapshot[cacheKey(a.platform, a.externalId)]
      return opts.force || !prev?.detailFetchedAt || (a.sourceUpdatedIso != null && prev.sourceUpdatedIso !== a.sourceUpdatedIso)
    }
    // `archivedDocumentSetHash` (not `documentSetHash`) is this task's own
    // bookkeeping — whether *this task* has ever archived a document set for
    // this auction, independent of whether reprocess.ts has parsed it yet.
    const needsDocumentSetCheck = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      const prev = previousSnapshot[cacheKey(a.platform, a.externalId)]
      return (
        opts.force ||
        !hit ||
        (a.attachments.length > 0 && hit.archivedDocumentSetHash == null) ||
        (a.sourceUpdatedIso != null && prev?.sourceUpdatedIso !== a.sourceUpdatedIso)
      )
    }
    const nativePhotoUrls = (a: Auction): string[] => [
      ...a.attachments
        .filter(
          (att) =>
            att.kind === 'photo' &&
            /^https?:\/\/.*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(att.proxyUrl),
        )
        .map((att) => att.proxyUrl),
      ...(a.photoUrls ?? []),
    ]
    const targetPhotoPipelineVersion = (a: Auction): number =>
      a.platform === 'se-kronofogden' && (a.photoUrls?.length ?? 0) > 0
        ? KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION
        : PHOTO_PIPELINE_VERSION
    // A prior attempt may never have run the actual photo pipeline or may
    // have thrown before completing. `photosCheckedAt` unset means "never
    // attempted". `photoPipelineVersion` lets one improved pipeline pass
    // revisit older confirmed-empty false negatives. Bounded by
    // MAX_PHOTO_FAILURES so a listing whose PDF/URLs genuinely cannot be
    // mined doesn't retry forever.
    const needsPhotoBackfill = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      const photos = hit?.photos?.length ?? 0
      const targetVersion = targetPhotoPipelineVersion(a)
      const pipelineDue =
        hit?.photosCheckedAt == null || (hit.photoPipelineVersion ?? 1) < targetVersion
      if (opts.force) {
        return (
          (photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0) &&
          (hit?.photoFailures ?? 0) < MAX_PHOTO_FAILURES
        )
      }
      return (
        hit != null &&
        pipelineDue &&
        (photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0) &&
        (hit.photoFailures ?? 0) < MAX_PHOTO_FAILURES
      )
    }
    const eligible = result.auctions.filter(
      (a) =>
        opts.force ||
        !cache[cacheKey(a.platform, a.externalId)] ||
        needsEnrich(a) ||
        needsDocumentSetCheck(a) ||
        needsPhotoBackfill(a),
    )
    const todo = interleaveByPlatform(eligible)
    console.log(`[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)archive`)

    let archived = 0
    let enrichedCount = 0
    let photoExtractions = 0
    let photosTotal = 0
    const at = new Date().toISOString()
    // Entries added/changed since the last flush. writeExtractionCache only
    // upserts what's actually dirty, not the whole (ever-growing) cache — see
    // extraction-cache.ts. Swapped out for a fresh object right before each
    // flush call, synchronously (no `await` in between), so no writer can add
    // to a batch that's already been handed off.
    let dirty: ExtractionCache = {}

    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        throwIfTaskAborted(signal)
        const a = todo[cursor++]
        if (!a) continue
        const crawler = byPlatform.get(a.platform)
        const key = cacheKey(a.platform, a.externalId)
        const priorEntry = cache[key]

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
        let currentDocumentSet: ArchivedDocumentSetResult | null = priorEntry?.archivedDocumentSetHash
          ? {
              setHash: priorEntry.archivedDocumentSetHash,
              version: priorEntry.archivedDocumentSetVersion ?? 0,
              changed: false,
            }
          : null
        if (needsDocumentSetCheck(a)) {
          const preparedDocuments = await prepareLiveLlmDocuments(a.attachments, documentIdentity, at)
          if (!preparedDocuments.documentSetComplete) {
            if (a.attachments.length > 0) {
              const detail = preparedDocuments.errors?.length ? `: ${preparedDocuments.errors.join('; ')}` : ''
              pushRunError('document_archive_incomplete', `Dokumentarchiv ${a.platform}:${a.externalId} ist unvollständig${detail}`, a)
            }
          } else {
            currentDocumentSet = await archiveDocumentSet(documentIdentity, preparedDocuments.documentSetItems, at)
            if (!currentDocumentSet && a.attachments.length > 0) {
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
        let photosCheckedAt = priorEntry?.photosCheckedAt
        let photoFailures = priorEntry?.photoFailures ?? 0
        let photoPipelineVersion = priorEntry?.photoPipelineVersion
        if (needsPhotoBackfill(a) && isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)) {
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          const priorPhotos = priorEntry?.photos?.map(normalizePhoto) ?? []
          const targetVersion = targetPhotoPipelineVersion(a)
          const rebuildingPhotoSet = (priorEntry?.photoPipelineVersion ?? 1) < targetVersion
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
          try {
            if (nativeFotoUrls.length > 0) {
              const nativePhotos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
              addNewlyDownloadedPhotos(nativePhotos)
              addDisplayedPhotos(nativePhotos)
              for (const name of nativePhotos) {
                const hash = imageContentHashFromFilename(name)
                if (hash) nativePhotoHashes.add(hash)
              }
            }
            if (a.attachments.length > 0) {
              photoExtractions++
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
            }
            photosTotal += photos.length
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
            // Completed without throwing — "checked", regardless of whether
            // any photos were actually found (a legitimately photo-less
            // listing/document stops being retried from here on).
            photosCheckedAt = at
            photoFailures = 0
            photoPipelineVersion = targetPhotoPipelineVersion(a)
          } catch (err) {
            photoFailures++
            pushRunError('photo_extraction', `Fotoextraktion ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
            if (photos.length === 0 && priorPhotos.length > 0) {
              photos = priorPhotos.map((photo) => photo.file)
            }
          }
          curatedPhotos = photos.length > 0
            ? photos.map((name) => priorPhotos.find((photo) => photo.file === name) ?? normalizePhoto(name))
            : undefined
        } else {
          curatedPhotos = priorEntry?.photos?.map(normalizePhoto)
        }

        // Write this task's own fields, carrying every extraction-owned field
        // (propertyType, condition, source, confidence, ...) forward
        // unchanged — reprocess.ts owns those and compares
        // archivedDocumentSetHash against its own documentSetHash to decide
        // what still needs (re)parsing.
        const entry: AuctionExtraction = priorEntry
          ? {
              ...priorEntry,
              photos: curatedPhotos,
              photosCheckedAt,
              photoFailures: photoFailures > 0 ? photoFailures : undefined,
              photoPipelineVersion,
              archivedDocumentSetHash: currentDocumentSet?.setHash ?? priorEntry.archivedDocumentSetHash ?? null,
              archivedDocumentSetVersion: currentDocumentSet?.version ?? priorEntry.archivedDocumentSetVersion ?? null,
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
              photosCheckedAt,
              photoFailures: photoFailures > 0 ? photoFailures : undefined,
              photoPipelineVersion,
              archivedDocumentSetHash: currentDocumentSet?.setHash ?? null,
              archivedDocumentSetVersion: currentDocumentSet?.version ?? null,
            }
        cache[key] = entry
        dirty[key] = entry
        archived++
        // Make this auction visible right away instead of waiting for the
        // whole run to finish — otherwise a freshly activated country shows
        // nothing in /search until every single listing has been (re)archived,
        // even though most of the work is already done. writeAuctionSnapshot/
        // upsertCurrentAuctions both upsert row-by-row, so a partial batch of
        // one is as safe as the final full-batch write below.
        try {
          if (a.marketValueEur == null) {
            const vwHit = vwCache[cacheKey(a.platform, a.externalId)]
            if (vwHit) {
              a.marketValueEur = vwHit.marketValueEur
              a.marketValueText = vwHit.marketValueText
            }
          }
          applyExtractionToAuctions([a], cache)
          await writeAuctionSnapshot([a])
          await upsertCurrentAuctions([a], at)
          await writeAuctionDetails(a, entry)
        } catch (err) {
          pushRunError('snapshot', `Snapshot ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
        }
        void recordTaskRunProgress('enrich', {
          regionsDone,
          regionsTotal,
          archivedDone: archived,
          archivedTotal: todo.length,
        })
        if (archived % FLUSH_EVERY === 0) {
          const toFlush = dirty
          dirty = {}
          const ok = await writeExtractionCache(toFlush)
          if (!ok) throw new Error('Extraktions-Cache konnte nicht gespeichert werden')
        }
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (Object.keys(dirty).length > 0 && !(await writeExtractionCache(dirty))) {
      throw new Error('Extraktions-Cache konnte nicht gespeichert werden')
    }

    // Snapshot the fully decorated crawl (photo URLs + cached Verkehrswerte)
    // so /api/auction/[platform]/[id] can serve detail pages without
    // re-running the crawlers. writeAuctionSnapshot's merge preserves the
    // previous snapshot's `.extraction` (this task never sets it) and any
    // other detail field this crawl didn't refresh. Also acts as a catch-all
    // for listings the per-item write above already covered (idempotent) and
    // for non-`todo` listings whose cached Verkehrswert only just arrived —
    // re-read fresh since the worker loop above may have taken a while.
    vwCache = await readVerkehrswertCache()
    for (const a of result.auctions) {
      throwIfTaskAborted(signal)
      if (a.marketValueEur != null) continue
      const hit = vwCache[cacheKey(a.platform, a.externalId)]
      if (!hit) continue
      a.marketValueEur = hit.marketValueEur
      a.marketValueText = hit.marketValueText
    }
    // Overlay whatever reprocess.ts has already extracted (this task doesn't
    // recompute it) so a listing that's due for a detail/document refresh
    // this run still shows its existing extraction immediately instead of
    // waiting on writeAuctionSnapshot's previous-value fallback.
    applyExtractionToAuctions(result.auctions, cache)
    normalizeAuctionDescriptions(result.auctions)
    await writeAuctionSnapshot(result.auctions)
    // Pair every snapshot write with auction_details, including auctions
    // outside `todo` above (per-item loop already covers those) — otherwise
    // a value only this catch-all pass refreshes (backfilled marketValueEur,
    // normalized description, a currentBid picked up by a plain re-crawl)
    // would land in auction_snapshot but never in auction_details.
    // writeAuctionDetails no-ops (a single SELECT, no INSERT) when nothing
    // actually changed, so this is cheap for the common case.
    for (const a of result.auctions) {
      throwIfTaskAborted(signal)
      try {
        await writeAuctionDetails(a, cache[cacheKey(a.platform, a.externalId)] ?? null)
      } catch (err) {
        pushRunError('auction_details', `auction_details ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
      }
    }
    // Record the final enriched payload, not the earlier list-only regional
    // shape. This keeps each analytical observation complete with detail,
    // document, photo and extraction fields available at this run.
    await recordObservations(result, capturedAt)
    // Structured Postgres mirror for fast SQL filter queries (Daten-API, admin
    // tooling) — additive, no-op without NUXT_DATABASE_URL. See
    // server/utils/current-auctions.ts.
    await upsertCurrentAuctions(result.auctions, at)
    for (const failure of result.errors) {
      pushRunError('crawl', `${failure.country}/${failure.region}: ${failure.message}`)
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
