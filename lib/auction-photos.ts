import type { Auction } from '~/types/auction'
import { normalizePhoto } from './photo'

/** Builds the complete display gallery, self-hosted only, from
 * `extraction.photos` (native crawler photos and document-extracted photos
 * alike, once the enrich pipeline has archived and curated them — see
 * server/tasks/enrich.ts). Raw crawler URLs (`auction.photoUrls`,
 * `attachment.proxyUrl`) are pipeline input only and never reach display, since
 * some are short-lived signed URLs. The thumbnail is only a last-resort
 * fallback for before the pipeline has run once. */
export function auctionPhotoUrls(auction: Auction): string[] {
  const urls: string[] = []
  const platform = encodeURIComponent(auction.platform)
  const externalId = encodeURIComponent(auction.externalId)
  for (const rawPhoto of auction.extraction?.photos ?? []) {
    const photo = normalizePhoto(rawPhoto)
    const url = `/api/auction-image/${platform}/${externalId}/${encodeURIComponent(photo.file)}`
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0 && auction.thumbnailUrl) urls.push(auction.thumbnailUrl)
  return urls
}
