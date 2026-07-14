import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { getRates, toEur } from '~/server/utils/exchange-rate'
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
  type?: Array<{ name?: string | null }> | null
  content?: ListContent | null
}

interface ListResponse {
  success: boolean
  data?: { response?: ListItem[] | null } | null
}

interface DetailInfo {
  amtsgericht: string | null
  aktenzeichen: string | null
  beschreibung: string | null
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
  return data.data?.response ?? []
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
 *  how the other crawlers store court-published times without a UTC offset). */
function parseAuctionDate(text: string | null | undefined): { iso: string | null; label: string | null } {
  if (!text) return { iso: null, label: null }
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2})\.(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, hh, mm] = m
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}, ${hh}:${mm} Uhr`,
  }
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
  const res = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'da,en;q=0.9', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`tvangsauktioner.dk ${url}: HTTP ${res.status}`)
  const html = await res.text()
  return {
    amtsgericht: extractRow(html, 'Retskreds'),
    aktenzeichen: extractRow(html, 'Sags nr'),
    beschreibung: extractDescription(html),
    pdfUrl: extractPdfUrl(html),
    photos: extractPhotos(html),
  }
}

function extractId(propertyLink: string): string {
  return propertyLink.match(/\/tvangsauktion\/(\d+)\//)?.[1] ?? propertyLink
}

function mapItem(
  item: ListItem,
  detail: DetailInfo,
  platformId: string,
  rates: Record<string, number>,
): Auction {
  const id = extractId(item.property_link)
  const content = item.content ?? {}
  const { iso: terminIso, label: terminText } = parseAuctionDate(content.start_date)

  const valueDkk = parseDkkAmount(content.value)
  const verkehrswertEur = valueDkk != null ? toEur(valueDkk, 'DKK', rates) : null

  const areaParts = [
    content.residence ? `Bolig: ${content.residence}` : null,
    content.profession && content.profession !== '0 m²' ? `Erhverv: ${content.profession}` : null,
    content.reason ? `Grund: ${content.reason}` : null,
  ].filter(Boolean)
  const beschreibung = [areaParts.join(', ') || null, detail.beschreibung]
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
    region: 'all',
    zvgId: id,
    aktenzeichen: detail.aktenzeichen ?? '',
    amtsgericht: detail.amtsgericht ?? 'Tvangsauktioner.dk',
    objekt: item.type?.[0]?.name ?? null,
    adresse: item.title ?? null,
    verkehrswertEur,
    verkehrswertText: valueDkk != null ? `${valueDkk.toLocaleString('de-DE')} DKK` : null,
    terminIso,
    terminText,
    aufgehoben: item.status != null && item.status !== 'active',
    letzteAktualisierungIso: null,
    pdfUrl: detail.pdfUrl,
    detailUrl: item.property_link,
    pdfUrlUpstream: detail.pdfUrl,
    detailUrlUpstream: item.property_link,
    attachments,
    beschreibung,
    fotoCount: detail.photos.length,
    thumbnailUrl: detail.photos[0] ?? content.image ?? null,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const [rates, items] = await Promise.all([getRates(), fetchListItems()])
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

  const auctions = items
    .map((item, i) => {
      const detail = details[i]
      if (!detail) return null
      return mapItem(item, detail, platformId, rates)
    })
    .filter((a): a is Auction => a !== null)

  return { auctions, total: auctions.length }
}
