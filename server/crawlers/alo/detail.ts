import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { UA } from './constants'
import { absoluteUrl, cleanMultiline, extractLatLng } from './text'

const FETCH_TIMEOUT_MS = 20_000

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
  const res = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'bg,en;q=0.8', 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`alo.bg detail ${auction.externalId}: HTTP ${res.status}`)
  const $ = load(await res.text())

  auction.description = extractDescription($)

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
