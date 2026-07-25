import type { Auction } from '~/types/auction'
import { normalizePhoto } from './photo'

/** Builds the complete display gallery from native crawler URLs and locally
 * mirrored/extracted document photos. The thumbnail is only a last-resort
 * fallback so a low-resolution preview is not duplicated beside full images. */
export function auctionPhotoUrls(auction: Auction): string[] {
  const urls: string[] = []
  const add = (url: string | null | undefined) => {
    if (url && !urls.includes(url)) urls.push(url)
  }

  for (const url of auction.photoUrls ?? []) add(url)
  for (const attachment of auction.attachments ?? []) {
    if (attachment.kind === 'photo') add(attachment.proxyUrl)
  }

  const platform = encodeURIComponent(auction.platform)
  const externalId = encodeURIComponent(auction.externalId)
  for (const rawPhoto of auction.extraction?.photos ?? []) {
    const photo = normalizePhoto(rawPhoto)
    add(`/api/auction-image/${platform}/${externalId}/${encodeURIComponent(photo.file)}`)
  }

  if (urls.length === 0) add(auction.thumbnailUrl)
  return urls
}
