import type { Auction, CrawlResult } from '~/types/auction'
import { MULTI_PLATFORM } from '~/lib/auction-constants'
import { platforms } from '~/server/crawlers/registry'
import { readAuctionRecordMap, type AuctionRecord } from '~/server/utils/auction-record'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { getRates } from '~/server/utils/exchange-rate'
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

/** Builds a crawlAll()-shaped result for exactly the requested identities,
 *  loaded from the same records map the rest of a scoped retry run needs
 *  anyway (`records`, returned alongside for reuse as runEnrich's
 *  `preloadedRecords`) — instead of paying for a live crawlAll() to
 *  rediscover auctions the caller already knows about. */
export async function loadScopedRetryResult(
  country: string | undefined,
  identities: { platform: string; externalId: string }[],
  capturedAt: string,
): Promise<{ result: CrawlResult & { errors: [] }; records: Map<string, AuctionRecord> }> {
  const records = await readAuctionRecordMap(country)
  const wanted = new Set(identities.map((i) => cacheKey(i.platform, i.externalId)))
  const auctions = [...records.values()]
    .filter((r) => wanted.has(cacheKey(r.auction.platform, r.auction.externalId)))
    .map((r) => r.auction)
  return {
    records,
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
  records,
}: {
  opts: EnrichOptions
  auctions: Auction[]
  fetchStates: Awaited<ReturnType<typeof readAuctionFetchStates>>
  artifactVersions: Awaited<ReturnType<typeof readLatestArtifactVersions>>
  records: Map<string, AuctionRecord>
}) {
  const byPlatform = new Map(platforms.map((p) => [p.id, p]))
  // opts.identities means `auctions` is already exactly the caller's scoped
  // retry set (see runEnrich) — treat it like force everywhere below, so a
  // manual "retry this one" / "retry failed" click always re-archives what
  // was asked for, regardless of whether it currently looks done.
  const scopedForce = opts.force || (opts.identities?.length ?? 0) > 0
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
  const needsPhotoBackfill = (a: Auction): boolean => {
    const key = cacheKey(a.platform, a.externalId)
    const hit = records.get(key)?.auction.extraction
    const state = fetchStates.get(key)
    const photos = hit?.photos?.length ?? 0
    const targetVersion = targetPhotoPipelineVersion(a)
    const pipelineDue =
      state?.photosCheckedAt == null ||
      (state.photoPipelineVersion ?? 1) < targetVersion
    const belowFailureCap =
      (state?.photoFailures ?? 0) < MAX_PHOTO_FAILURES || cooldownElapsed(state?.photoLastAttemptedAt)
    // This function runs twice per candidate: here (pre-enrichOne, to decide
    // eligibility) and again in enrich-worker.ts's per-auction loop right
    // after enrichOne mutated `a` (to decide whether to actually spend a
    // fetch). `a.attachments`/nativePhotoUrls(a) are a meaningful "is there
    // still a source" signal for platforms whose crawl() step already
    // embeds them — but dga-ag's list.ts always returns `attachments: []`
    // and no photoUrls; the object's own gallery/catalog link only exist
    // behind the detail page enrichOne fetches. For dga-ag this first
    // (pre-enrichOne) call would therefore always read as "no source" and
    // permanently block a photoPipelineVersion bump from ever rebuilding an
    // already-photographed auction without an explicit force (lived bug,
    // fixed 2026-08-20 for S26-03-009 et al. via a one-off DB reset — this
    // bypass makes that unnecessary for future version bumps). The bypass is
    // a no-op on the second, post-enrichOne call: by then dga-ag's
    // attachments are already populated, so the presence check would have
    // been true anyway.
    const hasPlausiblePhotoSource =
      photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0 || a.platform === 'dga-ag'
    if (scopedForce) {
      return hasPlausiblePhotoSource && belowFailureCap
    }
    return pipelineDue && hasPlausiblePhotoSource && belowFailureCap
  }
  const eligible = auctions.filter(
    (a) =>
      scopedForce ||
      !records.get(cacheKey(a.platform, a.externalId))?.auction.extraction ||
      needsEnrich(a) ||
      needsDocumentSetCheck(a) ||
      needsPhotoBackfill(a),
  )
  const todo = interleaveByPlatform(eligible)

  return {
    byPlatform,
    rates,
    vwCache,
    needsDocumentSetCheck,
    nativePhotoUrls,
    targetPhotoPipelineVersion,
    needsPhotoBackfill,
    todo,
  }
}
