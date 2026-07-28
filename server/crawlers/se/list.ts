import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { findTotalLandAreaSqm } from '~/server/utils/extract/sizes'
import { SE_BASE, COUNTRY, regionNameForKommun, regionNameForRegionCode } from './constants'
import { extractFact, parseSekAmount, extractBody, parseStorlek, cleanCategory, cleanKronofogdenAddress, extractShowingAddress } from './text'

const DETAIL_CONCURRENCY = 4
const ALL_LISTINGS_CACHE_MS = 5 * 60_000
const SEARCH_PATHS = [
  '/Sokfastigheterbostadsratter.html',
  '/22660.html',
] as const

let allListingsCache:
  | {
    platformId: string
    fetchRef: typeof fetch
    expiresAt: number
    promise: Promise<{ auctions: Auction[]; total: number | null }>
  }
  | null = null

async function htmlFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'sv,en;q=0.9',
      'User-Agent': 'zvg-immo/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`kronofogden.se ${url}: HTTP ${res.status}`)
  return res.text()
}

export function extractListingIds(html: string): string[] {
  const $ = load(html)
  const ids = new Set<string>()
  $('a.h3rubrik[href]').each((_i, el) => {
    const id = $(el).attr('href')?.match(/^\/(\d+)\.html$/)?.[1]
    if (id) ids.add(id)
  })
  return [...ids]
}

export function extractTotalHits(html: string): number | null {
  const $ = load(html)
  const m = $.root().text().match(/av totalt\s+(\d+)\s+tr[äa]ffar/i)
  if (!m?.[1]) return null
  const total = Number.parseInt(m[1], 10)
  return Number.isFinite(total) ? total : null
}

export function extractNextStartAtHit(html: string, currentStart: number): number | null {
  const $ = load(html)
  const starts: number[] = []
  $('a[href*="startAtHit="]').each((_i, el) => {
    const n = Number.parseInt($(el).attr('href')?.match(/[?&]startAtHit=(\d+)/)?.[1] ?? '', 10)
    if (Number.isFinite(n) && n > currentStart) starts.push(n)
  })
  starts.sort((a, b) => a - b)
  return starts[0] ?? null
}

function imageSortKey(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    const file = path.split('/').pop()?.toLowerCase()
    return file || path.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp)$/i
// Kronofogden's per-case upload filenames are inconsistent ("Bild1.jpg",
// "Bild-001.jpg", or plain "1.jpg" — depends on how the case officer
// uploaded them), so this is only a fallback signal for when we can't
// structurally scope to the gallery container (see extractKronofogdenPhotoUrls).
const BILD_FILENAME_RE = /\/bild[-\s]*\d+\.(?:jpe?g|png|webp)$/i

function isListingImageUrl(url: string, scopedToGallery: boolean): boolean {
  try {
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname)
    if (u.origin !== SE_BASE || !/^\/images\//i.test(path) || !IMAGE_EXT_RE.test(path)) {
      return false
    }
    return scopedToGallery || BILD_FILENAME_RE.test(path)
  } catch {
    return false
  }
}

function toAbsoluteListingImageUrl(raw: string, scopedToGallery: boolean): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed, SE_BASE)
    u.hash = ''
    return isListingImageUrl(u.href, scopedToGallery) ? u.href : null
  } catch {
    return null
  }
}

export function extractKronofogdenPhotoUrls(html: string): string[] {
  const $ = load(html)
  const galleria = $('#galleria').first()
  // Inside the gallery container every image is a real listing photo
  // regardless of filename; outside it (no galleria div found) filename
  // is the only signal left to reject chrome/logo/banner images.
  const scopedToGallery = galleria.length > 0
  const elements = scopedToGallery ? galleria.find('*') : $('*')
  const bestByImage = new Map<string, { url: string; width: number }>()

  function add(raw: string, width = 0) {
    const url = toAbsoluteListingImageUrl(raw, scopedToGallery)
    if (!url) return
    const key = imageSortKey(url)
    const current = bestByImage.get(key)
    if (!current || width > current.width) bestByImage.set(key, { url, width })
  }

  // Depth-first document order, so a gallery image found via `src` followed
  // by one found via `srcset` keeps that order (Map preserves first-insertion
  // order). cheerio's parser also decodes attribute entities and tracks tag
  // nesting for us, unlike the hand-rolled regex this used to be.
  elements.each((_i, el) => {
    if (!('attribs' in el)) return
    for (const [name, value] of Object.entries(el.attribs)) {
      if (!value) continue
      if (name === 'srcset') {
        for (const candidate of value.split(',')) {
          const m = candidate.trim().match(/^(\S+)(?:\s+(\d+)w)?$/i)
          if (!m?.[1]) continue
          add(m[1], m[2] ? Number.parseInt(m[2], 10) : 0)
        }
      } else if (name === 'src' || name === 'href' || name.startsWith('data-')) {
        add(value)
      }
    }
  })

  return [...bestByImage.values()].map((entry) => entry.url)
}

function searchUrl(path: string, startAtHit: number): string {
  const params = new URLSearchParams({ query: '*' })
  if (startAtHit > 0) params.set('startAtHit', String(startAtHit))
  return `${SE_BASE}${path}?${params.toString()}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchSearchIds(path: string): Promise<string[]> {
  const ids: string[] = []
  const seenStarts = new Set<number>()
  let startAtHit = 0

  while (!seenStarts.has(startAtHit)) {
    seenStarts.add(startAtHit)
    const html = await htmlFetch(searchUrl(path, startAtHit))
    ids.push(...extractListingIds(html))

    const next = extractNextStartAtHit(html, startAtHit)
    if (next != null) {
      startAtHit = next
      continue
    }

    const total = extractTotalHits(html)
    const inferredNext = startAtHit + 10
    if (total != null && inferredNext < total) {
      startAtHit = inferredNext
      continue
    }

    break
  }

  return ids
}

function mapDetail(id: string, html: string, platformId: string): Auction | null {
  const address = extractFact(html, 'Adress')
  const showingAddress = extractShowingAddress(html)
  const kommun = extractFact(html, 'Kommun')
  const regionName = regionNameForKommun(kommun) ?? 'Schweden'
  const marknadsvardRaw = extractFact(html, 'Marknadsvarde')
  const arendenummer = extractFact(html, 'Arendenummer') ?? ''
  const storlek = extractFact(html, 'Storlek')

  // Auction date: <div id="datumet">2026-08-27</div>
  const $ = load(html)
  const datumText = $('#datumet').first().text().trim()
  const auctionDateIso = /^\d{4}-\d{2}-\d{2}$/.test(datumText) ? datumText : null

  // The list page's href="/<id>.html" pattern also matches static info pages
  // (cookie notice, Visningsinformation, …). Those have neither an auction
  // date nor an address fact — drop them instead of emitting empty auctions.
  if (!auctionDateIso && !address) return null

  // First downloadable PDF attached to the listing
  const pdfHref = $('a[href^="/download/"][href$=".pdf"]').first().attr('href')
  const pdfUrl = pdfHref ? `${SE_BASE}${pdfHref}` : null

  const photoUrls = extractKronofogdenPhotoUrls(html)
  const thumbnailUrl = photoUrls[0] ?? null
  const photoCount = photoUrls.length

  // Prefer the showingAddress embedded in Kronofogden's booking widget: it
  // usually includes the postal code ("Kvarnbyn 76, 93794, Burträsk"), which
  // geocodes much more precisely than the sidebar's address + municipality.
  const addressParts = [address ? cleanKronofogdenAddress(address) : null, kommun].filter(Boolean)
  const fullAddress = addressParts.length > 0 ? addressParts.join(', ') : null

  const sekAmount = marknadsvardRaw ? parseSekAmount(marknadsvardRaw) : null

  // Structured size: "6 rum, 175 kvm" → rooms + living area
  const { rooms: sourceRooms, livingAreaSqm: sourceLivingAreaSqm } = parseStorlek(storlek)

  // Object type from the tax category ("Småhusenhet, bebyggd (220).") or,
  // failing that, the tenure form ("Äganderätt.").
  const title =
    cleanCategory(extractFact(html, 'Taxeringskod')) ??
    cleanCategory(extractFact(html, 'Upplatelseform'))

  // Build description: labelled facts first (more food for the central
  // extraction), then the body text.
  const byggar = extractFact(html, 'Byggar')
  const taxeringsvarde = extractFact(html, 'Taxeringsvarde')
  const fastighetsbeteckning = extractFact(html, 'Fastighetsbeteckning')
  const tomtbeskrivning = extractFact(html, 'Tomtbeskrivning')
  const beskrivningFact = extractFact(html, 'Beskrivning')
  const body = extractBody(html)
  const sourceLandAreaSqm = findTotalLandAreaSqm([tomtbeskrivning, beskrivningFact, body].filter(Boolean).join('\n'))
  const description = [
    storlek ? `Storlek: ${storlek}` : null,
    byggar && byggar !== '0' ? `Byggår: ${byggar}` : null,
    taxeringsvarde ? `Taxeringsvärde: ${taxeringsvarde}` : null,
    fastighetsbeteckning ? `Fastighetsbeteckning: ${fastighetsbeteckning}` : null,
    tomtbeskrivning ? `Tomtbeskrivning: ${tomtbeskrivning}` : null,
    beskrivningFact ? `Beskrivning: ${beskrivningFact}` : null,
    body,
  ]
    .filter(Boolean)
    .join('\n') || null

  const attachments: Attachment[] = pdfUrl
    ? [
        {
          // "Beskrivning och värdering" — the bailiff's description-and-
          // valuation report; classifyAttachment has no Swedish terms, so
          // tag the kind directly.
          kind: 'appraisal',
          label: 'Beskrivning och värdering',
          filename: pdfUrl.split('/').pop() ?? 'beskrivning-och-vardering.pdf',
          sizeBytes: null,
          fileId: pdfUrl,
          proxyUrl: pdfUrl,
        },
      ]
    : []

  return {
    platform: platformId,
    country: COUNTRY,
    region: regionName,
    externalId: id,
    caseNumber: arendenummer,
    authority: 'Kronofogden',
    title,
    address: showingAddress ?? fullAddress,
    marketValueEur: null,
    marketValue: sekAmount,
    currency: sekAmount != null ? 'SEK' : null,
    marketValueText: marknadsvardRaw ? `${marknadsvardRaw} SEK` : null,
    auctionDateIso,
    auctionDateText: auctionDateIso,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl,
    detailUrl: `${SE_BASE}/${id}.html`,
    pdfUrlUpstream: pdfUrl,
    detailUrlUpstream: `${SE_BASE}/${id}.html`,
    attachments,
    description,
    photoCount,
    thumbnailUrl,
    ...(photoUrls.length > 0 ? { photoUrls } : {}),
    sourceRooms,
    sourceLivingAreaSqm,
    sourceLandAreaSqm,
  }
}

export async function fetchAllListings(
  platformId: string,
  regionCode = 'all',
): Promise<{ auctions: Auction[]; total: number | null }> {
  const all = await fetchAllListingsUnfiltered(platformId)
  const regionName = regionNameForRegionCode(regionCode)
  const auctions = regionName
    ? all.auctions.filter((auction) => auction.region === regionName)
    : all.auctions
  return {
    auctions: auctions.map((auction) => ({ ...auction })),
    total: auctions.length,
  }
}

async function fetchAllListingsUnfiltered(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const now = Date.now()
  if (
    allListingsCache
    && allListingsCache.platformId === platformId
    && allListingsCache.fetchRef === fetch
    && allListingsCache.expiresAt > now
  ) {
    return allListingsCache.promise
  }

  const promise = fetchAllListingsFresh(platformId)
  allListingsCache = {
    platformId,
    fetchRef: fetch,
    expiresAt: now + ALL_LISTINGS_CACHE_MS,
    promise,
  }
  try {
    return await promise
  } catch (error) {
    if (allListingsCache?.promise === promise) allListingsCache = null
    throw error
  }
}

async function fetchAllListingsFresh(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const searchResults = await Promise.all(
    SEARCH_PATHS.map(async (path) => {
      try {
        return { path, ids: await fetchSearchIds(path), error: null }
      } catch (error) {
        return { path, ids: null, error }
      }
    }),
  )
  const failed = searchResults.filter((result) => result.error)
  if (failed.length === searchResults.length) {
    throw new Error(
      `kronofogden.se search failed: ${failed
        .map((result) => `${result.path}: ${errorMessage(result.error)}`)
        .join('; ')}`,
    )
  }
  for (const result of failed) {
    console.warn(`[se-kronofogden] search ${result.path}: ${errorMessage(result.error)}`)
  }

  const ids = [...new Set(searchResults.flatMap((result) => result.ids ?? []))]
  if (ids.length === 0) return { auctions: [], total: 0 }

  // Fetch detail pages with bounded concurrency
  const htmls: (string | null)[] = new Array(ids.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++
      const id = ids[i]
      if (!id) continue
      try {
        htmls[i] = await htmlFetch(`${SE_BASE}/${id}.html`)
      } catch {
        htmls[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = ids
    .map((id, i) => (htmls[i] ? mapDetail(id, htmls[i]!, platformId) : null))
    .filter((a): a is Auction => a !== null)

  return { auctions, total: auctions.length }
}

export async function fetchListingById(id: string, platformId: string): Promise<Auction | null> {
  if (!/^\d{1,20}$/.test(id)) return null
  const html = await htmlFetch(`${SE_BASE}/${id}.html`)
  return mapDetail(id, html, platformId)
}
