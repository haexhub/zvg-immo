import type { Auction, Attachment } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { ZVBAWU_BASE, UA } from './constants'
import { extractInertiaPage, parseSqm, stripHtml } from './text'

interface DetailImage {
  id: number
  thumbnail: string
  url: string
  caption?: string
}

interface DetailFact {
  key: string
  value: string
}

interface DetailSection {
  facts?: DetailFact[]
  content?: string
  /** Short amenity tags shown as badges on the page (e.g. "Balkon", "Keller",
   *  "Garage") — only present on `features`. */
  badges?: string[]
}

interface DetailPage {
  props: {
    auction: {
      id: number
      title: string
      address: string | null
      auctionDate: string | null
      price: string | null
      fileNumber: string | null
      summary: string | null
      description: string | null
      teaser: string | null
      interior: string | null
      features: DetailSection | null
      facilities: DetailSection | null
      accessories: DetailSection | null
      location: DetailSection | null
      bulletin: string | null
      latlng: [number, number] | null
      firstImage: DetailImage | null
      images: DetailImage[]
      cancelled: boolean
    }
  }
}

export interface DetailInfo {
  description: string | null
  attachments: Attachment[]
  photoCount: number
  thumbnailUrl: string | null
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  latlng: [number, number] | null
  cancelled: boolean
  caseNumber: string | null
  sourceLivingAreaSqm: number | null
  sourceLandAreaSqm: number | null
  sourceRooms: number | null
}

const FETCH_TIMEOUT_MS = 15_000

async function fetchDetail(link: string, identity: DocumentIdentity): Promise<DetailPage | null> {
  const url = `${ZVBAWU_BASE}${link.startsWith('/') ? link : `/${link}`}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9',
      },
    })
    if (!res.ok) return null
    const body = await res.text()
    // zvbawü is an Inertia.js SSR shell — the facts live in a `data-page` JSON
    // attribute (extractInertiaPage below), not in prosaic HTML. Archived
    // anyway: the raw response body still preserves the facts.
    await archiveDetailCapture(Buffer.from(body, 'utf8'), identity, url, new Date().toISOString())
    return extractInertiaPage<DetailPage>(body)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildAttachments(d: DetailPage['props']['auction']): Attachment[] {
  const out: Attachment[] = []
  if (d.bulletin) {
    const filename = d.bulletin.split('/').pop() || 'bekanntmachung.pdf'
    out.push({
      kind: 'announcement',
      label: 'Terminsbekanntmachung',
      filename,
      sizeBytes: null,
      // Synthesize a stable id from the auction id — zvbawü doesn't expose one
      // for the PDF, and the kind+label tuple already uniquely identifies it.
      fileId: `bulletin-${d.id}`,
      proxyUrl: d.bulletin,
    })
  }
  for (const img of d.images || []) {
    out.push({
      kind: 'photo',
      label: img.caption || `Foto ${img.id}`,
      filename: img.url.split('/').pop() || `${img.id}.jpg`,
      sizeBytes: null,
      fileId: String(img.id),
      proxyUrl: img.url,
    })
  }
  return out
}

function factValue(facts: DetailFact[], keyRe: RegExp): string | null {
  return facts.find((f) => keyRe.test(f.key.trim()))?.value ?? null
}

/** Pure mapping from the Inertia auction payload — exported for tests. */
export function buildDetailInfo(a: DetailPage['props']['auction']): DetailInfo {
  const facts = a.features?.facts ?? []
  const factLines = facts.map((f) => `${f.key}: ${f.value}`).join('\n')
  const badges = a.features?.badges ?? []
  const badgeLine = badges.length > 0 ? `Merkmale: ${badges.join(', ')}` : ''
  const locationFactLines = (a.location?.facts ?? []).map((f) => `${f.key}: ${f.value}`).join('\n')
  const facilities = stripHtml(a.facilities?.content)
  // `interior` mirrors facilities.content on most listings — only include it
  // when it actually differs.
  const interior =
    a.interior && a.interior !== a.facilities?.content ? stripHtml(a.interior) : ''
  const accessories = stripHtml(a.accessories?.content)
  const locationContent = stripHtml(a.location?.content)
  const location = [locationFactLines, locationContent].filter(Boolean).join('\n')
  const description =
    [
      a.teaser?.trim(),
      stripHtml(a.summary),
      stripHtml(a.description),
      factLines,
      badgeLine,
      facilities && `Ausstattung:\n${facilities}`,
      interior && `Innenausstattung:\n${interior}`,
      accessories && `Zubehör:\n${accessories}`,
      location && `Lage:\n${location}`,
    ]
      .filter(Boolean)
      .join('\n\n') || null

  const roomsRaw = factValue(facts, /^(anzahl\s+)?zimmer\b/i)
  const rooms = roomsRaw ? parseFloat(roomsRaw.replace(',', '.')) : NaN

  return {
    description,
    attachments: buildAttachments(a),
    photoCount: (a.images || []).length || (a.firstImage ? 1 : 0),
    thumbnailUrl: a.firstImage?.thumbnail ?? null,
    pdfUrl: a.bulletin || null,
    pdfUrlUpstream: a.bulletin || null,
    latlng: a.latlng ?? null,
    cancelled: Boolean(a.cancelled),
    caseNumber: a.fileNumber || null,
    sourceLivingAreaSqm: parseSqm(factValue(facts, /^wohnfläche/i)),
    sourceLandAreaSqm: parseSqm(factValue(facts, /^grundstücks(fläche|größe)/i)),
    sourceRooms: Number.isFinite(rooms) && rooms > 0 ? rooms : null,
  }
}

export async function fetchDetailFor(link: string, identity: DocumentIdentity): Promise<DetailInfo | null> {
  const page = await fetchDetail(link, identity)
  if (!page) return null
  return buildDetailInfo(page.props.auction)
}

export async function enrichInBatches(
  items: Auction[],
  onEnriched: (item: Auction, info: DetailInfo) => void,
  concurrency = 8,
): Promise<{ enriched: number; errors: number }> {
  let cursor = 0
  let enriched = 0
  let errors = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      if (!item) continue
      // Cancelled auctions consistently return HTTP 410 from the detail
      // endpoint. We already know they're cancelled from the list view, so
      // skipping spares 11 wasted requests and keeps the error count
      // meaningful — it then reflects only unexpected failures.
      if (item.cancelled) continue
      if (!item.detailUrlUpstream) continue
      try {
        const identity: DocumentIdentity = {
          platform: item.platform,
          country: item.country,
          region: item.region,
          externalId: item.externalId,
          caseNumber: item.caseNumber,
          authority: item.authority,
        }
        const info = await fetchDetailFor(item.detailUrlUpstream.replace(ZVBAWU_BASE, ''), identity)
        if (info) {
          onEnriched(item, info)
          enriched++
        } else {
          // Null = fetch failed or upstream returned non-OK / unparsable HTML.
          // Surface as an error so the aggregate count reflects reality.
          errors++
        }
      } catch {
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors }
}
