import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { fetchAloPage } from './fetch'
import { absoluteUrl, cleanMultiline, extractLatLng } from './text'

function extractDescription($: ReturnType<typeof load>): string | null {
  const box = $('.more-info .word-break-all').first().clone()
  if (box.length === 0) return null
  box.find('br').replaceWith('\n')
  return cleanMultiline(box.text())
}

/**
 * Full-resolution gallery links (`a.fancyimages[data-type="image"]`) inside
 * `#images-wrapper` — covers both the single big head shot
 * (`#main_image_flex`) and the smaller thumbnails strip (`#images`), all of
 * which share this class/attribute pair. The one other `.fancyimages`
 * anchor on this page (`#gallerygoogle`) is an ajax-loaded extra-photos
 * placeholder (`data-type="ajax"`), not a real image, and is excluded by the
 * attribute selector.
 */
function extractPhotoUrls($: ReturnType<typeof load>): string[] {
  const hrefs = $('#images-wrapper a.fancyimages[data-type="image"]')
    .map((_i, a) => $(a).attr('href'))
    .get()
    .filter((href): href is string => Boolean(href))
    .map(absoluteUrl)
  return [...new Set(hrefs)]
}

export async function enrichOne(auction: Auction): Promise<void> {
  const url = auction.detailUrlUpstream ?? auction.detailUrl
  if (!url) return
  const res = await fetchAloPage(url)
  if (!res.ok) throw new Error(`alo.bg detail ${auction.externalId}: HTTP ${res.status}`)
  const $ = load(await res.text())

  // Only ever overwrite when a value was actually found (same convention as
  // kip/text.ts): if alo.bg renames the description box, a blind assignment
  // would wipe the description already stored for this auction and starve LLM
  // extraction of its input.
  const description = extractDescription($)
  if (description) auction.description = description

  const mapsHref = $('a[href*="maps.google.com"]').first().attr('href')
  const { lat, lng } = extractLatLng(mapsHref)
  if (lat != null && lng != null) {
    auction.lat = lat
    auction.lng = lng
  }

  const photoUrls = extractPhotoUrls($)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = auction.thumbnailUrl ?? photoUrls[0] ?? null
  }
}
