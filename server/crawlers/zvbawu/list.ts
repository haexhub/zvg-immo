import type { Auction } from '~/types/auction'
import { ZVBAWU_BASE, UA, COUNTRY } from './constants'
import { extractInertiaPage, parseEuro, parseGermanDateTimeString } from './text'

interface ListFact {
  key: string
  value: string
}

interface ListAuction {
  id: number
  title: string
  slug: string
  link: string
  address: string | null
  city: string | null
  price: string | null
  priceType: string | null
  cancelled: boolean
  timestamp: string | null
  auctionDate: string | null
  firstImage: { thumbnail: string; url: string } | null
  facts: ListFact[]
}

interface ListPage {
  props: {
    auctions: {
      data: ListAuction[]
      meta: { current_page: number; last_page: number; total: number }
    }
  }
}

const REGION_NAME = 'Baden-Württemberg'

const FETCH_TIMEOUT_MS = 15_000

/** Throws on HTTP/network/timeout/payload failures: an empty court result is
 *  indistinguishable from "this court has no auctions", so a failed fetch must
 *  reject crawlCourt for index.ts to withhold the platform's success. */
async function fetchPage(courtSlug: string, page: number): Promise<ListPage> {
  const url = `${ZVBAWU_BASE}/amtsgerichte/${courtSlug}/zwangsversteigerungen${page > 1 ? `?page=${page}` : ''}`
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = extractInertiaPage<ListPage>(await res.text())
    if (!parsed) throw new Error('no Inertia page payload')
    return parsed
  } catch (err) {
    throw new Error(`zvbawü ${url} failed: ${(err as Error).message}`, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}

function deriveAuthority(facts: ListFact[], courtName: string): string {
  // Listing always renders the fact key as "Amtsgericht <Name>:" — but we
  // also have the static court name from constants, which is canonical.
  for (const f of facts) {
    const m = f.key.match(/Amtsgericht\s+(.+?):?$/i)
    if (m?.[1]) return m[1].trim()
  }
  return courtName
}

function deriveCaseNumber(facts: ListFact[]): string {
  // The first fact's value is the Aktenzeichen ("1 K 13/24").
  const first = facts[0]
  return first?.value?.trim() || ''
}

function mapAuction(
  raw: ListAuction,
  platformId: string,
  courtName: string,
): Auction {
  const facts = raw.facts ?? []
  const detailPath = raw.link.startsWith('/') ? raw.link : `/${raw.link}`
  const detailUrlUpstream = `${ZVBAWU_BASE}${detailPath}`
  return {
    platform: platformId,
    country: COUNTRY,
    region: REGION_NAME,
    externalId: String(raw.id),
    caseNumber: deriveCaseNumber(facts),
    authority: deriveAuthority(facts, courtName),
    title: raw.title || null,
    address: raw.address || raw.city || null,
    marketValueEur: parseEuro(raw.price),
    marketValueText: raw.price || null,
    auctionDateIso: parseGermanDateTimeString(raw.auctionDate),
    auctionDateText: raw.auctionDate || null,
    cancelled: Boolean(raw.cancelled),
    sourceUpdatedIso: raw.timestamp || null,
    pdfUrl: null,
    detailUrl: detailUrlUpstream,
    pdfUrlUpstream: null,
    detailUrlUpstream,
    attachments: [],
    description: null,
    photoCount: raw.firstImage ? 1 : 0,
    thumbnailUrl: raw.firstImage?.thumbnail ?? null,
  }
}

export interface CourtParseResult {
  totalReported: number
  auctions: Auction[]
}

export async function crawlCourt(
  court: { slug: string; name: string },
  platformId: string,
): Promise<CourtParseResult> {
  const first = await fetchPage(court.slug, 1)
  const meta = first.props.auctions.meta
  const auctions = first.props.auctions.data.map((a) => mapAuction(a, platformId, court.name))
  // last_page can be >1 for high-volume courts (per_page=12).
  for (let p = 2; p <= meta.last_page; p++) {
    const page = await fetchPage(court.slug, p)
    for (const a of page.props.auctions.data) {
      auctions.push(mapAuction(a, platformId, court.name))
    }
  }
  return { totalReported: meta.total, auctions }
}
