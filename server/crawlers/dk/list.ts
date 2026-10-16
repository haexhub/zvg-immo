import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { AJAX_URL, DK_BASE, UA, COUNTRY } from './constants'

const DETAIL_CONCURRENCY = 4

interface ListContent {
  bid?: string | null
  auction?: string | null
  start_date?: string | null
  value?: string | null
  residence?: string | null
  profession?: string | null
  reason?: string | null
  image?: string | null
}

interface ListItem {
  status?: string | null
  title?: string | null
  property_link: string
  /** Coordinates come as decimal strings, e.g. "56.577023530507". */
  lat?: string | number | null
  lng?: string | number | null
  type?: Array<{ name?: string | null }> | null
  content?: ListContent | null
}

interface ListResponse {
  success: boolean
  data?: { response?: ListItem[] | null } | null
}

interface DetailInfo {
  authority: string | null
  caseNumber: string | null
  description: string | null
  pdfUrl: string | null
  photos: string[]
}

async function fetchListItems(): Promise<ListItem[]> {
  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ action: 'get_all_posts_ajax' }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`tvangsauktioner.dk ajax: HTTP ${res.status}`)
  const data = (await res.json()) as ListResponse
  if (!data.success || !Array.isArray(data.data?.response)) {
    throw new Error('tvangsauktioner.dk ajax returned an unsuccessful response')
  }
  return data.data.response
}

/** DKK amounts are formatted like "Kr. 1.030.000" / "210.000 Kr." — dot as
 *  thousands separator, no decimals. */
function parseDkkAmount(text: string | null | undefined): number | null {
  if (!text) return null
  // Must start on a digit — "Kr. 1.030.000" has a lone "." right after "Kr"
  // that a bare [\d.]+ would match first, producing an empty number.
  const m = text.match(/(\d[\d.]*)/)
  if (!m) return null
  const n = Number(m[1]!.replace(/\./g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "17.08.2026, 13.30" -> "2026-08-17T13:30:00" (naive local time, matching
 *  how the other crawlers store court-published times without a UTC offset).
 *  Morning slots omit the leading zero on the hour ("19.08.2026, 9.30");
 *  day/month/minute are always two digits in the live feed. */
export function parseAuctionDate(text: string | null | undefined): { iso: string | null; label: string | null } {
  if (!text) return { iso: null, label: null }
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{1,2})\.(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, h, mm] = m
  const hh = h!.padStart(2, '0')
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}, ${hh}:${mm} Uhr`,
  }
}

function parseCoord(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? n : null
}

function extractRow(html: string, label: string): string | null {
  const re = new RegExp(
    `<div class="title">${label}</div>\\s*<(?:div|a)[^>]*class="value"[^>]*>([\\s\\S]*?)</(?:div|a)>`,
    'i',
  )
  const m = html.match(re)
  if (!m) return null
  const text = m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

function extractDescription(html: string): string | null {
  const m = html.match(/<div class="content readmore__content">([\s\S]*?)<\/div>/i)
  if (!m) return null
  const text = m[1]!
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.length > 0 ? text : null
}

function extractPdfUrl(html: string): string | null {
  const m = html.match(/class="pdf-file-wrapper[^"]*"\s+data-url="([^"]+)"/i)
  return m?.[1] ?? null
}

function extractPhotos(html: string): string[] {
  const wrapperM = html.match(/swiper-wrapper">([\s\S]*?)<div class="swiper-button/i)
  const scope = wrapperM?.[1] ?? ''
  const urls = scope.match(/src="(https:\/\/www\.tvangsauktioner\.dk\/wp-content\/uploads\/[^"]+\.(?:jpe?g|png))"/gi) ?? []
  return [...new Set(urls.map((u) => u.match(/src="([^"]+)"/)![1]!))]
}

async function fetchDetail(url: string): Promise<DetailInfo> {
  const parsedUrl = new URL(url, DK_BASE)
  if (parsedUrl.origin !== new URL(DK_BASE).origin) {
    throw new Error(`Unexpected detail URL origin: ${parsedUrl.origin}`)
  }
  const res = await fetch(parsedUrl, {
    headers: { Accept: 'text/html', 'Accept-Language': 'da,en;q=0.9', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`tvangsauktioner.dk ${url}: HTTP ${res.status}`)
  const html = await res.text()
  return {
    authority: extractRow(html, 'Retskreds'),
    caseNumber: extractRow(html, 'Sags nr'),
    description: extractDescription(html),
    pdfUrl: extractPdfUrl(html),
    photos: extractPhotos(html),
  }
}

function extractId(propertyLink: string): string {
  return propertyLink.match(/\/tvangsauktion\/(\d+)\//)?.[1] ?? propertyLink
}

function mapItem(item: ListItem, detail: DetailInfo, platformId: string): Auction {
  const id = extractId(item.property_link)
  const content = item.content ?? {}
  const { iso: auctionDateIso, label: auctionDateText } = parseAuctionDate(content.start_date)

  const valueDkk = parseDkkAmount(content.value)

  const areaParts = [
    content.residence ? `Bolig: ${content.residence}` : null,
    content.profession && content.profession !== '0 m²' ? `Erhverv: ${content.profession}` : null,
    content.reason ? `Grund: ${content.reason}` : null,
  ].filter(Boolean)
  const description = [areaParts.join(', ') || null, detail.description]
    .filter(Boolean)
    .join('\n') || null

  const attachments: Attachment[] = detail.pdfUrl
    ? [
        {
          kind: classifyAttachment(detail.pdfUrl, 'salgsopstilling'),
          label: 'Salgsopstilling',
          filename: 'salgsopstilling.pdf',
          sizeBytes: null,
          fileId: detail.pdfUrl,
          proxyUrl: detail.pdfUrl,
        },
      ]
    : []

  return {
    platform: platformId,
    country: COUNTRY,
    // Empty, not the 'all' scope literal: Auction.region is a human-readable
    // region name (rendered as a badge on the detail page and in the map
    // popover), so a nationwide-only source leaves it blank the way every
    // other one does — otherwise the UI shows a region called "all".
    region: '',
    externalId: id,
    caseNumber: detail.caseNumber ?? '',
    authority: detail.authority ?? 'Tvangsauktioner.dk',
    title: item.type?.[0]?.name ?? null,
    address: item.title ?? null,
    marketValueEur: null,
    marketValue: valueDkk,
    currency: valueDkk != null ? 'DKK' : null,
    marketValueText: valueDkk != null ? `${valueDkk.toLocaleString('de-DE')} DKK` : null,
    auctionDateIso,
    auctionDateText,
    cancelled: item.status != null && item.status !== 'active',
    sourceUpdatedIso: null,
    pdfUrl: detail.pdfUrl,
    detailUrl: item.property_link,
    pdfUrlUpstream: detail.pdfUrl,
    detailUrlUpstream: item.property_link,
    attachments,
    description,
    photoCount: detail.photos.length,
    thumbnailUrl: detail.photos[0] ?? content.image ?? null,
    photoUrls: detail.photos.length > 0 ? detail.photos : undefined,
    lat: parseCoord(item.lat),
    lng: parseCoord(item.lng),
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const items = await fetchListItems()
  if (items.length === 0) return { auctions: [], total: 0 }

  const details: (DetailInfo | null)[] = new Array(items.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      if (!item) continue
      try {
        details[i] = await fetchDetail(item.property_link)
      } catch {
        details[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const emptyDetail: DetailInfo = {
    authority: null,
    caseNumber: null,
    description: null,
    pdfUrl: null,
    photos: [],
  }
  const auctions = items.map((item, i) => mapItem(item, details[i] ?? emptyDetail, platformId))

  return { auctions, total: auctions.length }
}
