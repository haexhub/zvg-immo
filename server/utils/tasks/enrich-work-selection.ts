import type { Auction, CrawlResult } from '~/types/auction'
import { MULTI_PLATFORM } from '~/lib/auction-constants'
import { platforms } from '~/server/crawlers/registry'
import { iterateAuctionRecords, readAuctionRecordsByKeys, type AuctionRecord } from '~/server/utils/auction-record'
import type { StoredMarketValue } from '~/server/utils/exchange-rate'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { loadRatesOrPegged } from '~/server/utils/exchange-rate'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import type { readAuctionFetchStates } from '~/server/utils/auction-fetch-state'
import type { readLatestArtifactVersions } from '~/server/utils/artifact-version-state'
import type { EnrichOptions } from './enrich-worker'

const MAX_PHOTO_FAILURES = 3
const PHOTO_FAILURE_RETRY_COOLDOWN_HOURS = 24
const PHOTO_PIPELINE_VERSION = 4
const KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION = 5
/** Forces a one-time rebuild of dga-ag photo sets after fixing the shared
 *  multi-lot catalog PDF bleeding every other lot's images into each
 *  auction's gallery (see excludeFromDocumentMining). */
const DGA_AG_PHOTO_PIPELINE_VERSION = 6

/** What the run-start eligibility check (and the EUR-conversion fallback) needs
 *  from a stored auction. The full record — extraction, photos, description —
 *  is re-read per auction when it is actually processed; keeping every record
 *  of the table for the whole (hours-long) run cost ~220-350 MB of heap. */
export interface StoredAuctionSummary {
  hasExtraction: boolean
  photoCount: number
  marketValue: StoredMarketValue
}

export function summarizeRecord(record: AuctionRecord): StoredAuctionSummary {
  const { auction } = record
  return {
    hasExtraction: auction.extraction != null,
    photoCount: auction.extraction?.photos?.length ?? 0,
    marketValue: { currency: auction.currency, marketValue: auction.marketValue, marketValueEur: auction.marketValueEur },
  }
}

/** Summaries of every stored auction (optionally of one country), folded from a
 *  streamed read so only one block of records is ever in memory. */
export async function readStoredAuctionSummaries(country?: string): Promise<Map<string, StoredAuctionSummary>> {
  const summaries = new Map<string, StoredAuctionSummary>()
  for await (const record of iterateAuctionRecords(country)) {
    summaries.set(cacheKey(record.auction.platform, record.auction.externalId), summarizeRecord(record))
  }
  return summaries
}

/** Builds a crawlAll()-shaped result for exactly the requested identities,
 *  read by key from the store (`summaries`, returned alongside, is what
 *  prepareEnrichWork needs for them) — instead of paying for a live crawlAll()
 *  to rediscover auctions the caller already knows about. */
export async function loadScopedRetryResult(
  identities: { platform: string; externalId: string }[],
  capturedAt: string,
): Promise<{ result: CrawlResult & { errors: [] }; summaries: Map<string, StoredAuctionSummary> }> {
  const records = await readAuctionRecordsByKeys(identities)
  const auctions = [...records.values()].map((r) => r.auction)
  return {
    summaries: new Map([...records].map(([key, record]) => [key, summarizeRecord(record)])),
    result: {
      platform: MULTI_PLATFORM, source: '', countries: [...new Set(auctions.map((a) => a.country))],
      // Replayed from stored records, not crawled — no platform may be marked
      // as freshly crawled here, or every auction outside this scoped retry
      // would read as disappeared.
      platformsSucceeded: [],
      regions: [], fetchedAt: capturedAt, totalReported: null, auctions, errors: [],
    },
  }
}

export async function prepareEnrichWork({
  opts,
  auctions,
  fetchStates,
  artifactVersions,
  stored,
}: {
  opts: EnrichOptions
  auctions: Auction[]
  fetchStates: Awaited<ReturnType<typeof readAuctionFetchStates>>
  artifactVersions: Awaited<ReturnType<typeof readLatestArtifactVersions>>
  stored: Map<string, StoredAuctionSummary>
}) {
  const byPlatform = new Map(platforms.map((p) => [p.id, p]))
  // opts.identities means `auctions` is already exactly the caller's scoped
  // retry set (see runEnrich) — treat it like force everywhere below, so a
  // manual "retry this one" / "retry failed" click always re-archives what
  // was asked for, regardless of whether it currently looks done.
  const scopedForce = opts.force || (opts.identities?.length ?? 0) > 0
  // Unconditional: enrichOne can still reveal a non-EUR value (HU, PL).
  const rates = await loadRatesOrPegged()
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
    const key = cacheKey(a.platform, a.externalId)
    const prev = fetchStates.get(key)
    return scopedForce || !prev?.detailFetchedAt || (a.sourceUpdatedIso != null && prev.sourceUpdatedIso !== a.sourceUpdatedIso)
  }
  const needsDocumentSetCheck = (a: Auction): boolean => {
    const key = cacheKey(a.platform, a.externalId)
    const latestArtifact = artifactVersions.get(key)
    const prev = fetchStates.get(key)
    return (
      scopedForce ||
      (!latestArtifact && (a.attachments.length > 0 || prev?.detailFetchedAt == null)) ||
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
      : a.platform === 'dga-ag'
        ? DGA_AG_PHOTO_PIPELINE_VERSION
        : PHOTO_PIPELINE_VERSION
  // Whether a locked-out listing (photoFailures >= MAX_PHOTO_FAILURES) is
  // past its cooldown and can retry again — see
  // PHOTO_FAILURE_RETRY_COOLDOWN_HOURS. A never-attempted timestamp (older
  // rows predating this column) counts as elapsed rather than blocking
  // eligibility on a value that doesn't exist yet.
  const nowMs = Date.now()
  function cooldownElapsed(lastAttemptedAt: string | null | undefined): boolean {
    if (!lastAttemptedAt) return true
    return nowMs - new Date(lastAttemptedAt).getTime() >= PHOTO_FAILURE_RETRY_COOLDOWN_HOURS * 60 * 60 * 1000
  }
  // A prior attempt may never have run the actual photo pipeline or may
  // have thrown before completing. `photosCheckedAt` unset means "never
  // attempted". `photoPipelineVersion` lets one improved pipeline pass
  // revisit older confirmed-empty false negatives. Bounded by
  // MAX_PHOTO_FAILURES so a listing whose PDF/URLs genuinely cannot be
  // mined doesn't retry forever — unless the cooldown since the last
  // attempt has elapsed (see cooldownElapsed above).
  // This function runs twice per candidate: once here at the 'eligibility'
  // phase (pre-enrichOne, to decide whether the auction enters `todo` at
  // all) and again from enrich-worker.ts's per-auction loop at the default
  // 'extraction' phase, right after enrichOne mutated `a` (to decide whether
  // to actually spend a fetch). `a.attachments`/nativePhotoUrls(a) are a
  // meaningful "is there still a source" signal for platforms whose crawl()
  // step already embeds them — but dga-ag's list.ts always returns
  // `attachments: []` and no photoUrls; the object's own gallery/catalog
  // link only exist behind the detail page enrichOne fetches. At the
  // 'eligibility' phase that would therefore always read as "no source" and
  // permanently block a photoPipelineVersion bump from ever rebuilding an
  // already-photographed dga-ag auction without an explicit force (lived
  // bug, fixed 2026-08-20 for S26-03-009 et al. via a one-off DB reset — this
  // bypass makes that unnecessary for future version bumps). The bypass must
  // NOT extend to the 'extraction' phase: if enrichOne itself throws (e.g. a
  // transient detail-fetch failure), `a.attachments` stays empty there too,
  // and treating that as "source present" would let the pipeline mark
  // itself done with zero photos — wiping a previously good photo set.
  const needsPhotoBackfill = (a: Auction, phase: 'eligibility' | 'extraction' = 'extraction'): boolean => {
    const key = cacheKey(a.platform, a.externalId)
    const state = fetchStates.get(key)
    const photos = stored.get(key)?.photoCount ?? 0
    const targetVersion = targetPhotoPipelineVersion(a)
    const pipelineDue =
      state?.photosCheckedAt == null ||
      (state.photoPipelineVersion ?? 1) < targetVersion
    const belowFailureCap =
      (state?.photoFailures ?? 0) < MAX_PHOTO_FAILURES || cooldownElapsed(state?.photoLastAttemptedAt)
    const dgaAgPreEnrichBypass = phase === 'eligibility' && a.platform === 'dga-ag'
    const hasPlausiblePhotoSource =
      photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0 || dgaAgPreEnrichBypass
    if (scopedForce) {
      return hasPlausiblePhotoSource && belowFailureCap
    }
    return pipelineDue && hasPlausiblePhotoSource && belowFailureCap
  }
  const eligible = auctions.filter(
    (a) =>
      scopedForce ||
      !stored.get(cacheKey(a.platform, a.externalId))?.hasExtraction ||
      needsEnrich(a) ||
      needsDocumentSetCheck(a) ||
      needsPhotoBackfill(a, 'eligibility'),
  )
  const todo = interleaveByPlatform(eligible)

  return {
    byPlatform,
    rates,
    vwCache,
    scopedForce,
    needsDocumentSetCheck,
    nativePhotoUrls,
    targetPhotoPipelineVersion,
    needsPhotoBackfill,
    todo,
  }
}
