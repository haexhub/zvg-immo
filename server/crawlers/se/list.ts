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

const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp)$/i
// Kronofogden's per-case upload filenames are inconsistent ("Bild1.jpg",
// "Bild-001.jpg", or plain "1.jpg" — depends on how the case officer
// uploaded them), so this is only a fallback signal for when we can't
// structurally scope to the gallery container (see extractGalleriaContent).
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
  const decoded = decodeHtmlAttribute(raw).trim()
  if (!decoded) return null
  try {
    const u = new URL(decoded, SE_BASE)
    u.hash = ''
    return isListingImageUrl(u.href, scopedToGallery) ? u.href : null
  } catch {
    return null
  }
}

/** Returns the inner HTML of `<div id="galleria">…</div>`, tracking nested
 *  div depth to find its true matching close tag — unlike a non-greedy
 *  regex (which would stop at the first nested `</div>`) or taking the rest
 *  of the document (which would also sweep up unrelated images, e.g. footer
 *  logos/banners, appearing later on the page). Returns null if no galleria
 *  div is present, or if its matching close tag can't be found (fail closed
 *  rather than falling back to unrelated later content). */
function extractGalleriaContent(html: string): string | null {
  const openMatch = /<div\b[^>]*\bid=["']galleria["'][^>]*>/i.exec(html)
  if (!openMatch) return null
  const start = openMatch.index + openMatch[0].length
  const tagRe = /<div\b|<\/div\s*>/gi
  tagRe.lastIndex = start
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html))) {
    if (match[0].startsWith('</')) {
      if (--depth === 0) return html.slice(start, match.index)
    } else {
      depth++
    }
  }
  return null
}

export function extractKronofogdenPhotoUrls(html: string): string[] {
  const galleryContent = extractGalleriaContent(html)
  const source = galleryContent ?? html
  // Inside the gallery container every image is a real listing photo
  // regardless of filename; outside it (no galleria div found) filename
  // is the only signal left to reject chrome/logo/banner images.
  const scopedToGallery = galleryContent != null
  const bestByImage = new Map<string, { url: string; width: number }>()

  function add(raw: string, width = 0) {
    const url = toAbsoluteListingImageUrl(raw, scopedToGallery)
    if (!url) return
    const key = imageSortKey(url)
    const current = bestByImage.get(key)
    if (!current || width > current.width) bestByImage.set(key, { url, width })
  }

  // A single pass in source order, so a gallery image found via `src`
  // followed by one found via `srcset` keeps that order — scanning srcset
  // separately first would reverse it (Map preserves first-insertion order).
  for (const match of source.matchAll(/\b(srcset|src|href|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi)) {
    const attr = match[1]!.toLowerCase()
    const value = match[2]
    if (!value) continue
    if (attr === 'srcset') {
      const srcset = decodeHtmlAttribute(value)
      for (const candidate of srcset.split(',')) {
        const m = candidate.trim().match(/^(\S+)(?:\s+(\d+)w)?$/i)
        if (!m?.[1]) continue
        add(m[1], m[2] ? Number.parseInt(m[2], 10) : 0)
      }
    } else {
      add(value)
    }
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

export async function fetchListingById(id: string, platformId: string): Promise<Auction | null> {
  if (!/^\d{1,20}$/.test(id)) return null
  const html = await htmlFetch(`${SE_BASE}/${id}.html`)
  return mapDetail(id, html, platformId)
}
