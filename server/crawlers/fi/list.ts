import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { FI_BASE, LIST_URL, REAL_ESTATE_CATEGORY, UA, COUNTRY } from './constants'

const DETAIL_CONCURRENCY = 4
const MAX_PAGES = 30

interface ApiAttachment {
  id: number
  filename: string
  url: string
}

interface ApiMedia {
  thumbnail?: string | null
  largeImage?: string | null
  videoId?: string | null
}

interface ApiEntry {
  id: number
  slug: string
  title: string
  categoryName?: string | null
  description?: string | null
  location?: string | null
  auctionStart?: string | null
  auctionEnd?: string | null
  startPrice?: number | null
  highestBid?: number | null
  bidCount?: number | null
  isCancelled?: boolean
  fundsAreCanceled?: boolean
  /** Viewing appointment, plain text, e.g. "08.07.2026 klo 14:00 - 15:00". */
  exhibit?: string | null
  geocode?: { latitude?: number | null; longitude?: number | null } | null
  metadata?: { category?: string | null } | null
  medias?: ApiMedia[] | null
  attachments?: ApiAttachment[] | null
}

interface ApiSeller {
  displayName?: string | null
}

interface ApiResponse {
  entry: ApiEntry
  seller: ApiSeller
}

async function htmlFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'fi,en;q=0.9', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`huutokaupat.com ${url}: HTTP ${res.status}`)
  return res.text()
}

function extractListingIds(html: string): string[] {
  const raw = html.match(/href="\/kohde\/(\d+)\//g) ?? []
  return [...new Set(raw.map((m) => m.match(/\/kohde\/(\d+)\//)![1]!))]
}

async function discoverIds(): Promise<string[]> {
  const seen = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await htmlFetch(`${LIST_URL}?sivu=${page}`)
    const ids = extractListingIds(html)
    const before = seen.size
    for (const id of ids) seen.add(id)
    if (ids.length === 0 || seen.size === before) break
  }
  return [...seen]
}

function stripHtml(html: string): string | null {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&aring;/g, 'å')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.length > 0 ? text : null
}

function formatTerminText(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const formatted = date.toLocaleString('de-DE', {
    timeZone: 'Europe/Helsinki',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${formatted} Uhr`
}

async function fetchDetail(id: string): Promise<ApiResponse | null> {
  const res = await fetch(`${FI_BASE}/api/net-auctions/${id}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`huutokaupat.com detail ${id}: HTTP ${res.status}`)
  return (await res.json()) as ApiResponse
}

function mapDetail(id: string, data: ApiResponse, platformId: string): Auction {
  const { entry, seller } = data
  const description = entry.description ? stripHtml(entry.description) : null
  const bid = entry.highestBid ?? 0
  const price = bid > 0 ? bid : (entry.startPrice ?? null)
  const priceLabel = bid > 0 ? 'korkein tarjous' : 'lähtöhinta'

  const attachments: Attachment[] = (entry.attachments ?? []).map((a) => ({
    kind: classifyAttachment(a.filename),
    label: a.filename,
    filename: a.filename,
    sizeBytes: null,
    fileId: String(a.id),
    proxyUrl: `${FI_BASE}${a.url}`,
  }))
  const pdfHeadline =
    attachments.find((a) => a.kind === 'exposee') ??
    attachments.find((a) => /\.pdf$/i.test(a.filename))

  const photos = (entry.medias ?? []).filter((m) => !m.videoId && (m.thumbnail || m.largeImage))
  // Fall back to the thumbnail for medias without a largeImage so fotoCount
  // (= photoUrls.length) matches the gallery actually served.
  const photoUrls = photos
    .map((m) => m.largeImage ?? m.thumbnail)
    .filter((u): u is string => Boolean(u))
  const thumbnailUrl = photos[0]?.thumbnail ?? photos[0]?.largeImage ?? null

  const exhibit = entry.exhibit?.trim() || null
  const beschreibung = [description, exhibit ? `Besichtigung: ${exhibit}` : null]
    .filter(Boolean)
    .join('\n') || null

  const detailUrl = `${FI_BASE}/kohde/${entry.id}/${entry.slug}`

  return {
    platform: platformId,
    country: COUNTRY,
    region: 'all',
    zvgId: id,
    aktenzeichen: '',
    amtsgericht: seller.displayName ?? 'Ulosottolaitos',
    objekt: entry.categoryName ?? null,
    adresse: entry.location ?? null,
    verkehrswertEur: price,
    verkehrswertText: price != null ? `${price.toLocaleString('de-DE')} € (${priceLabel})` : null,
    terminIso: entry.auctionEnd ?? null,
    terminText: formatTerminText(entry.auctionEnd),
    aufgehoben: Boolean(entry.isCancelled) || Boolean(entry.fundsAreCanceled),
    letzteAktualisierungIso: null,
    pdfUrl: pdfHeadline?.proxyUrl ?? null,
    detailUrl,
    pdfUrlUpstream: pdfHeadline?.proxyUrl ?? null,
    detailUrlUpstream: detailUrl,
    attachments,
    beschreibung,
    fotoCount: photoUrls.length,
    thumbnailUrl,
    photoUrls,
    lat: typeof entry.geocode?.latitude === 'number' ? entry.geocode.latitude : null,
    lng: typeof entry.geocode?.longitude === 'number' ? entry.geocode.longitude : null,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const ids = await discoverIds()
  if (ids.length === 0) return { auctions: [], total: 0 }

  const results: (Auction | null)[] = new Array(ids.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++
      const id = ids[i]
      if (!id) continue
      try {
        const data = await fetchDetail(id)
        if (data?.entry?.metadata?.category === REAL_ESTATE_CATEGORY) {
          results[i] = mapDetail(id, data, platformId)
        }
      } catch {
        results[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = results.filter((a): a is Auction => a !== null)
  return { auctions, total: auctions.length }
}
