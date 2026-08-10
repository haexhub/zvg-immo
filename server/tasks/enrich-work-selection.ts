import type { Auction } from '~/types/auction'
import { platforms } from '~/server/crawlers/registry'
import type { AuctionRecord } from '~/server/utils/auction-record'
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
    return opts.force || !prev?.detailFetchedAt || (a.sourceUpdatedIso != null && prev.sourceUpdatedIso !== a.sourceUpdatedIso)
  }
  const needsDocumentSetCheck = (a: Auction): boolean => {
    const key = cacheKey(a.platform, a.externalId)
    const latestArtifact = artifactVersions.get(key)
    const prev = fetchStates.get(key)
    return (
      opts.force ||
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
    if (opts.force) {
      return (photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0) && belowFailureCap
    }
    return (
      pipelineDue &&
      (photos === 0 || nativePhotoUrls(a).length > 0 || a.attachments.length > 0) &&
      belowFailureCap
    )
  }
  const eligible = auctions.filter(
    (a) =>
      opts.force ||
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
