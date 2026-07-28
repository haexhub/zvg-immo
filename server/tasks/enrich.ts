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
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractDocumentPhotos } from '~/server/utils/extract/document-images'
import { prepareLiveLlmDocuments } from '~/server/utils/extract/llm-documents'
import {
  applyExtractionToAuctions,
  type ExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from '~/server/utils/extraction-cache'
import { imagesBucketConfigured, uploadImage } from '~/server/utils/image-storage'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import {
  archiveAuction,
  archiveDocumentSet,
  type ArchivedDocumentSetResult,
} from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'
import { normalizeAuctionDescription, normalizeAuctionDescriptions } from '~/server/utils/description-normalization'
import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const ENRICH_CONCURRENCY = 8
const FLUSH_EVERY = 200
// Give up retrying a listing whose photo pipeline (native download / document
// extraction) keeps *throwing* after this many attempts. A listing that
// completes an attempt but legitimately has no usable photos stops retrying
// immediately (photosCheckedAt gets set); this bound only guards against
// persistent errors.
const MAX_PHOTO_FAILURES = 3
const PHOTO_PIPELINE_VERSION = 2
const KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION = 3
// Cap on photos mined across *all* candidate documents for one listing.
// Gutachten/Exposés are frequently split across PDF/DOCX/HTML attachments
// (Teil 1, Teil 2, Anlagen), so mining stops only once this many are found
// or every candidate has been tried — not after the first document.
const MAX_DOCUMENT_PHOTOS_PER_LISTING = 12

// Guards against overlapping runs: a cold-start bootstrap run (many detail
// fetches + document downloads) can still be active when the cron tick
// fires. Two concurrent runs would double-fetch details and race on the
// snapshot write.
let running = false

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions, fetch detail pages, and download/archive documents + photos. No extraction — see the reprocess task.',
  },
  async run() {
    if (running) {
      console.warn('[enrich] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      await recordTaskRunStart('enrich')
      const outcome = await runEnrich()
      await recordTaskRunEnd('enrich', { result: outcome.result })
      return outcome
    } catch (err) {
      await recordTaskRunEnd('enrich', { error: (err as Error).message })
      throw err
    } finally {
      running = false
    }
  },
})

export async function runEnrich() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const previousSnapshot = await readAuctionSnapshot()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const rates = await getRates()

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
      return !prev?.detailFetchedAt || (a.sourceUpdatedIso != null && prev.sourceUpdatedIso !== a.sourceUpdatedIso)
    }
    // `archivedDocumentSetHash` (not `documentSetHash`) is this task's own
    // bookkeeping — whether *this task* has ever archived a document set for
    // this auction, independent of whether reprocess.ts has parsed it yet.
    const needsDocumentSetCheck = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      const prev = previousSnapshot[cacheKey(a.platform, a.externalId)]
      return (
        !hit ||
        (a.attachments.length > 0 && hit.archivedDocumentSetHash === undefined) ||
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
      return (
        hit != null &&
        pipelineDue &&
        (photos === 0 || nativePhotoUrls(a).length > 0) &&
        (hit.photoFailures ?? 0) < MAX_PHOTO_FAILURES
      )
    }
    const eligible = result.auctions.filter(
      (a) =>
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
          } catch {
            // Transient (network / BOE captcha): leave detailFetchedAt unset so
            // this listing is retried on the next run.
          }
        }
        // Runs regardless of whether this platform has its own enrichOne step
        // — a crawler without one (e.g. se-kronofogden) already returns the
        // final description/market-value data straight from the list crawl,
        // so these must not be skipped just because there was no separate
        // fetch to wait for.
        let detailOk = false
        if (fetchDone) {
          try {
            normalizeAuctionDescription(a)
            applyDescriptionMarketValue(a)
            deriveMarketValueEur(a, rates)
            detailOk = true
            a.detailFetchedAt = at
            // Re-archive now that detail data (description/attachments/
            // source*) is on the auction — a new content hash whenever
            // enrichment actually added something (see raw-archive.ts).
            await archiveAuction(a, at)
          } catch {
            // Transient: leave detailFetchedAt unset so this listing is
            // retried on the next run.
          }
        }
        if (enriched) enrichedCount++

        // Document archiving: download every candidate attachment and store
        // its bytes (raw_document_sets/raw_document_set_items + raw_blobs).
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
          const documentIdentity = {
            platform: a.platform,
            country: a.country,
            region: a.region,
            externalId: a.externalId,
            caseNumber: a.caseNumber,
            authority: a.authority,
          }
          const preparedDocuments = await prepareLiveLlmDocuments(a.attachments, documentIdentity, at)
          if (preparedDocuments.documentSetComplete) {
            currentDocumentSet = await archiveDocumentSet(documentIdentity, preparedDocuments.documentSetItems, at)
          }
        }

        // Photo pipeline — native image URLs first, PDF/document mining as a
        // fallback. Downloads/mines files onto local disk (mirrored to the
        // images bucket when configured) and records a deterministic,
        // uncategorized CuratedPhoto list; reprocess.ts's LLM call later
        // refines the categories, it never (re)downloads the files.
        let curatedPhotos: CuratedPhoto[] | undefined
        let photosCheckedAt = priorEntry?.photosCheckedAt
        let photoFailures = priorEntry?.photoFailures ?? 0
        let photoPipelineVersion = priorEntry?.photoPipelineVersion
        if (needsPhotoBackfill(a) && isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)) {
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          const priorPhotos = priorEntry?.photos?.map(normalizePhoto) ?? []
          let photos = priorPhotos.map((photo) => photo.file)
          let newlyDownloadedPhotos: string[] = []
          const nativeFotoUrls = nativePhotoUrls(a)
          try {
            if (nativeFotoUrls.length > 0) {
              newlyDownloadedPhotos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
              photos = [...new Set([...photos, ...newlyDownloadedPhotos])]
            }
            if (photos.length === 0 && a.attachments.length > 0) {
              photoExtractions++
              newlyDownloadedPhotos = await extractDocumentPhotos(a.attachments, {
                destDir,
                maxPhotos: MAX_DOCUMENT_PHOTOS_PER_LISTING,
              })
              photos = newlyDownloadedPhotos
            }
            photosTotal += photos.length
            // Mirror the freshly written files into the images bucket (WP-4) so
            // /api/auction-image can fall back to Supabase once the local cache
            // is gone. Best-effort — uploadImage never throws and no-ops
            // without a configured bucket; skip re-reading the files off disk
            // entirely in that (default) case.
            if (imagesBucketConfigured()) {
              for (const name of [...new Set(newlyDownloadedPhotos)]) {
                const bytes = await readFile(join(destDir, name))
                await uploadImage(bytes, `${a.platform}/${a.externalId}/${name}`)
              }
            }
            // Completed without throwing — "checked", regardless of whether
            // any photos were actually found (a legitimately photo-less
            // listing/document stops being retried from here on).
            photosCheckedAt = at
            photoFailures = 0
            photoPipelineVersion = targetPhotoPipelineVersion(a)
          } catch (err) {
            photoFailures++
            console.warn(
              `[enrich] photo extraction failed for ${a.platform}:${a.externalId}: ${(err as Error).message}`,
            )
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
        if (archived % FLUSH_EVERY === 0) {
          const toFlush = dirty
          dirty = {}
          const ok = await writeExtractionCache(toFlush)
          // On a failed upsert, re-merge the batch into dirty so the next
          // flush retries it instead of silently losing it from Postgres.
          if (!ok) dirty = { ...toFlush, ...dirty }
        }
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (Object.keys(dirty).length > 0) await writeExtractionCache(dirty)

    // Snapshot the fully decorated crawl (photo URLs + cached Verkehrswerte)
    // so /api/auction/[platform]/[id] can serve detail pages without
    // re-running the crawlers. writeAuctionSnapshot's merge preserves the
    // previous snapshot's `.extraction` (this task never sets it) and any
    // other detail field this crawl didn't refresh.
    const vwCache = await readVerkehrswertCache()
    for (const a of result.auctions) {
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
    // Structured Postgres mirror for fast SQL filter queries (Daten-API, admin
    // tooling) — additive, no-op without NUXT_DATABASE_URL. See
    // server/utils/current-auctions.ts.
    await upsertCurrentAuctions(result.auctions, at)

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} todo=${todo.length} archived=${archived} enriched=${enrichedCount} photos=${photosTotal}/${photoExtractions}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        new: todo.length,
        archived,
        enriched: enrichedCount,
        photoExtractions,
        photosTotal,
        durationMs,
      },
    }
}
