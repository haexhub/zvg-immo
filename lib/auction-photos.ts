import type { Auction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto, sortCuratedPhotos } from './photo'

export function curatedAuctionPhotoUrls(
  platformRaw: string,
  externalIdRaw: string,
  rawPhotos: readonly (string | CuratedPhoto)[] | undefined,
  thumbnailUrl: string | null = null,
): string[] {
  const urls: string[] = []
  const platform = encodeURIComponent(platformRaw)
  const externalId = encodeURIComponent(externalIdRaw)
  const seenFiles = new Set<string>()
  const photos = sortCuratedPhotos((rawPhotos ?? []).map(normalizePhoto)).filter((photo) => {
    if (seenFiles.has(photo.file)) return false
    seenFiles.add(photo.file)
    return true
  })
  for (const photo of photos) {
    const url = `/api/auction-image/${platform}/${externalId}/${encodeURIComponent(photo.file)}`
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0 && thumbnailUrl) urls.push(thumbnailUrl)
  return urls
}

/** Builds the complete display gallery, self-hosted only, from
 * `extraction.photos` (native crawler photos and document-extracted photos
 * alike, once the enrich pipeline has archived and curated them — see
 * server/tasks/enrich.ts). Raw crawler URLs (`auction.photoUrls`,
 * `attachment.proxyUrl`) are pipeline input only and never reach display, since
 * some are short-lived signed URLs. The thumbnail is only a last-resort
 * fallback for before the pipeline has run once. */
export function auctionPhotoUrls(auction: Auction): string[] {
  return curatedAuctionPhotoUrls(
    auction.platform,
    auction.externalId,
    auction.extraction?.photos,
    auction.thumbnailUrl,
  )
}
