import type { Attachment, Auction } from '~/types/auction'
import { findTotalLandAreaSqm } from '~/server/utils/extract/sizes'
import { SE_BASE, COUNTRY } from './constants'
import { extractFact, parseSekAmount, extractBody, parseStorlek, cleanCategory, cleanKronofogdenAddress, extractShowingAddress } from './text'

const DETAIL_CONCURRENCY = 4
const SEARCH_PATHS = [
  '/Sokfastigheterbostadsratter.html',
  '/22660.html',
] as const

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
  const links = html.match(/<a\b[^>]*href=["']\/\d+\.html["'][^>]*>/gi) ?? []
  const ids = links
    .filter((link) => /\bclass=["'][^"']*\bh3rubrik\b/i.test(link))
    .map((link) => link.match(/href=["']\/(\d+)\.html["']/i)?.[1])
    .filter((id): id is string => !!id)
  return [...new Set(ids)]
}

export function extractTotalHits(html: string): number | null {
  const m = html.match(/av totalt\s+(\d+)\s+tr[äa]ffar/i)
  if (!m?.[1]) return null
  const total = Number.parseInt(m[1], 10)
  return Number.isFinite(total) ? total : null
}

export function extractNextStartAtHit(html: string, currentStart: number): number | null {
  const starts = [...html.matchAll(/[?&](?:amp;)?startAtHit=(\d+)/g)]
    .map((m) => Number.parseInt(m[1]!, 10))
    .filter((n) => Number.isFinite(n) && n > currentStart)
    .sort((a, b) => a - b)
  return starts[0] ?? null
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
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

function isLikelyListingPhoto(url: string): boolean {
  try {
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname)
    return (
      u.origin === SE_BASE &&
      /^\/images\//i.test(path) &&
      /\/bild\s*\d+\.(?:jpe?g|png|webp)$/i.test(path)
    )
  } catch {
    return false
  }
}

function toAbsoluteListingImageUrl(raw: string): string | null {
  const decoded = decodeHtmlAttribute(raw).trim()
  if (!decoded) return null
  try {
    const u = new URL(decoded, SE_BASE)
    u.hash = ''
    return isLikelyListingPhoto(u.href) ? u.href : null
  } catch {
    return null
  }
}

export function extractKronofogdenPhotoUrls(html: string): string[] {
  const gallery = html.match(/<div\b[^>]*\bid=["']galleria["'][^>]*>[\s\S]*?<\/div>/i)?.[0]
  const source = gallery ?? html
  const bestByImage = new Map<string, { url: string; width: number }>()

  function add(raw: string, width = 0) {
    const url = toAbsoluteListingImageUrl(raw)
    if (!url) return
    const key = imageSortKey(url)
    const current = bestByImage.get(key)
    if (!current || width > current.width) bestByImage.set(key, { url, width })
  }

  for (const match of source.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    const srcset = decodeHtmlAttribute(match[1] ?? '')
    for (const candidate of srcset.split(',')) {
      const m = candidate.trim().match(/^(\S+)(?:\s+(\d+)w)?$/i)
      if (!m?.[1]) continue
      add(m[1], m[2] ? Number.parseInt(m[2], 10) : 0)
    }
  }

  for (const match of source.matchAll(/\b(?:src|href|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1]) add(match[1])
  }

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
  const marknadsvardRaw = extractFact(html, 'Marknadsvarde')
  const arendenummer = extractFact(html, 'Arendenummer') ?? ''
  const storlek = extractFact(html, 'Storlek')

  // Auction date: <div id="datumet" ...>2026-08-27</div>
  const datumM = html.match(/<div id="datumet"[^>]*>(\d{4}-\d{2}-\d{2})<\/div>/)
  const auctionDateIso = datumM?.[1] ?? null

  // The list page's href="/<id>.html" pattern also matches static info pages
  // (cookie notice, Visningsinformation, …). Those have neither an auction
  // date nor an address fact — drop them instead of emitting empty auctions.
  if (!auctionDateIso && !address) return null

  // First downloadable PDF attached to the listing
  const pdfM = html.match(/href="(\/download\/[^"]+\.pdf)"/)
  const pdfUrl = pdfM?.[1] ? `${SE_BASE}${pdfM[1]}` : null

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
    region: 'all',
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
