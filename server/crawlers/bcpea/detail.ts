import { load, type Cheerio, type CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { Attachment, Auction } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { BASE_URL, UA } from './constants'
import { clean, cleanMultiline } from './text'

const FETCH_TIMEOUT_MS = 20_000

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * The main object's own facts (incl. ОПИСАНИЕ and the scanned-notice links)
 * all sit inside one "item__expanded .col--info" box — verified live this is
 * the only place this markup appears once a court-district/authority/etc.
 * fact has already been read from the list card. A "similar properties"
 * strip further down the same detail page reuses the search-result card
 * markup (the same "item__group"/"label__group" classes list.ts parses), so
 * this must stay scoped to `.item__expanded` and never fall back to a
 * page-wide selector.
 */
function findLabelGroup($: CheerioAPI, infoBox: Cheerio<AnyNode>, label: string): Cheerio<AnyNode> | null {
  const match = infoBox
    .find('[class*="label__group"]')
    .filter((_i, el) => clean($(el).find('.label').first().text()) === label)
    .first()
  return match.length > 0 ? match : null
}

function extractDescription($: CheerioAPI, infoBox: Cheerio<AnyNode>): string | null {
  const group = findLabelGroup($, infoBox, 'ОПИСАНИЕ')
  if (!group) return null
  const info = group.find('.info').first().clone()
  info.find('br').replaceWith('\n')
  return cleanMultiline(info.text())
}

function extractAttachments($: CheerioAPI, infoBox: Cheerio<AnyNode>): Attachment[] {
  const group = findLabelGroup($, infoBox, 'Сканирани обявления')
  if (!group) return []
  return group
    .find('.info a')
    .map((_i, a): Attachment => {
      const $a = $(a)
      const href = absoluteUrl($a.attr('href') ?? '')
      const filename = clean($a.text()) ?? href.split('/').pop() ?? 'обявление.pdf'
      return {
        kind: 'announcement',
        label: filename,
        filename,
        sizeBytes: null,
        fileId: href,
        proxyUrl: href,
      }
    })
    .get()
}

/** Full-resolution links (`a.item-image[href]`), not the `?w=270&h=270`
 *  thumbnail `<img src>` — verified live both point at the same file for the
 *  head shot, but only the anchor href stays uncropped for the gallery
 *  thumbnails below it. Scoped to `.col--images` inside `.item__expanded`,
 *  never `.col--image` (singular) — that's the unrelated search-card class
 *  used both by list.ts and by this same page's "similar properties" strip. */
function extractPhotoUrls($: CheerioAPI, expanded: Cheerio<AnyNode>): string[] {
  const hrefs = expanded
    .find('.col--images a.item-image')
    .map((_i, a) => $(a).attr('href'))
    .get()
    .filter((href): href is string => Boolean(href) && !href.includes('photo-placeholder'))
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
  if (!res.ok) throw new Error(`sales.bcpea.org detail ${auction.externalId}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await archiveDetailCapture(
    bytes,
    {
      platform: auction.platform,
      country: auction.country,
      region: auction.region,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber,
      authority: auction.authority,
    } satisfies DocumentIdentity,
    url,
    new Date().toISOString(),
  )

  const $ = load(bytes.toString('utf8'))
  const expanded = $('.item__expanded').first()
  const infoBox = expanded.find('.col--info').first()
  if (infoBox.length === 0) return

  auction.description = extractDescription($, infoBox)

  const attachments = extractAttachments($, infoBox)
  if (attachments.length > 0) auction.attachments = attachments

  const photoUrls = extractPhotoUrls($, expanded)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = photoUrls[0] ?? null
  }
}
