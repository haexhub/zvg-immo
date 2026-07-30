import type { Auction } from '~/types/auction'
import { BG_API_BASE, BG_BASE, COUNTRY, REAL_ESTATE_PROPERTY_TYPE, UA } from './constants'
import { clean, formatBgDateText, formatBgPrice, parseBgAddress, parseBgPrice, stripBgHtml } from './text'

const LIST_URL = `${BG_API_BASE}/announcements`

export interface BgAnnouncement {
  id: number
  code: string | null
  caseNumber: string | null
  title: string | null
  description: string | null
  propertyType: string | null
  startPrice: number | null
  gpkTax: number | null
  auctionStartDate: string | null
  cancelled: boolean
  createdByFirstName: string | null
  createdByLastName: string | null
}

export function mapAnnouncement(a: BgAnnouncement, platformId: string): Auction {
  const title = clean(a.title)
  const descriptionText = stripBgHtml(a.description)
  const price = parseBgPrice(a.startPrice)
  const authority = clean([a.createdByFirstName, a.createdByLastName].filter(Boolean).join(' ')) ?? ''
  const detailUrl = `${BG_BASE}/#/announcements/display/${a.id}`

  return {
    platform: platformId,
    country: COUNTRY,
    region: '',
    externalId: String(a.id),
    caseNumber: clean(a.caseNumber) ?? clean(a.code) ?? '',
    authority,
    title,
    address: parseBgAddress(title, descriptionText),
    marketValueEur: price,
    marketValueText: formatBgPrice(price),
    // The e-auction portal is an online-bidding platform (bidStep, live
    // registrationsCount) — startPrice both opens the bidding and doubles as
    // the reserve, same convention as si/fi/hu/pl/boe.
    startingBid: price,
    sourceSecurityDeposit: parseBgPrice(a.gpkTax),
    auctionDateIso: a.auctionStartDate ?? null,
    auctionDateText: formatBgDateText(a.auctionStartDate),
    cancelled: a.cancelled,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments: [],
    description: descriptionText || null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const res = await fetch(LIST_URL, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`zapori.mjs.bg list fetch failed: HTTP ${res.status}`)

  const data = (await res.json()) as BgAnnouncement[]
  const auctions = data
    .filter((a) => a.propertyType === REAL_ESTATE_PROPERTY_TYPE)
    // Unlike every other portal's list endpoint, /announcements returns the
    // full historical archive (auctions going back years), not just upcoming
    // ones — `cancelled` here means "withdrawn by court", not "date passed".
    // Drop concluded auctions ourselves so they don't show up as active.
    .filter((a) => a.auctionStartDate == null || Date.parse(a.auctionStartDate) >= Date.now())
    .map((a) => mapAnnouncement(a, platformId))

  return { auctions, total: auctions.length }
}
