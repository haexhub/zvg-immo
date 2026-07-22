import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { CA_BASE, INDEX_URL, UA, COUNTRY } from './constants'

const DETAIL_CONCURRENCY = 4

function clean(text: string | null | undefined): string | null {
  const t = text?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** CAD amounts are formatted like "$42,092.73" / "$143,000" — comma thousands
 *  separator, optional cents. */
function parseCadAmount(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/\$?\s*([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number(m[1]!.replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

export async function htmlFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'en-CA,en;q=0.9', 'User-Agent': UA },
    redirect: 'follow',
    // ontariotaxsales.ca serves large Divi pages slowly (6–16 s each observed),
    // so allow a generous per-request budget.
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ontariotaxsales.ca ${url}: HTTP ${res.status}`)
  return res.text()
}

/** Collects the dated municipality sale-page URLs from the upcoming-sales index.
 *  Slugs look like /tax-sales/fort-erie-2026-07-15/. */
async function discoverSalePages(): Promise<string[]> {
  const $ = load(await htmlFetch(INDEX_URL))
  const base = new URL(CA_BASE).origin
  const urls = new Set<string>()
  $('a[href*="/tax-sales/"]').each((_i, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const abs = href.startsWith('http') ? href : `${CA_BASE}${href.startsWith('/') ? '' : '/'}${href}`
    let u: URL
    try {
      u = new URL(abs)
    } catch {
      return
    }
    if (u.origin !== base) return
    if (/\/tax-sales\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\/?$/i.test(u.pathname)) {
      urls.add(`${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`)
    }
  })
  return [...urls]
}

export interface LegalInfo {
  rollNo: string | null
  pin: string | null
  legal: string | null
  assessedCad: number | null
}

/** The sale page repeats, once per property, a legal block of the form
 *  "Roll No. <n>; <address>; PIN <pin> (LT); <legal desc>; <municipality>;
 *  File No. <fileNo>" immediately followed by "…the assessed value of the land
 *  … is $<amount>". Splitting the page text on "Roll No." yields one chunk per
 *  property; each is keyed by its File No. so it can be joined to the matching
 *  property-summary card. */
function parseLegalBlocks(pageText: string): Map<string, LegalInfo> {
  const byFileNo = new Map<string, LegalInfo>()
  const chunks = pageText.split(/Roll No\.?/i).slice(1)
  for (const chunk of chunks) {
    // Most pages write "File No. 24-06"; some municipalities instead embed a
    // prefixed variant like "FILE YKRH26-002" in the legal description.
    const fileNo = clean(
      chunk.match(/File No\.?\s*([\w-]+)/i)?.[1] ??
        chunk.match(/\bFILE\s+([A-Z]{2,}[\w-]*\d[\w-]*)/)?.[1],
    )
    if (!fileNo) continue
    const rollNo = clean(chunk.match(/^\s*([\d ]{10,40})/)?.[1])
    const pin = clean(chunk.match(/PIN\s*([\d-]+)/i)?.[1])
    const assessedCad = parseCadAmount(
      chunk.match(/assessed value of the land[^$]*\$\s*([\d,]+)/i)?.[1],
    )
    // Legal description: between the PIN and the trailing "File No." marker.
    const legal = clean(
      chunk
        .match(/PIN\s*[\d-]+\s*(?:\([^)]*\))?;([\s\S]*?);\s*[^;]*;\s*File No\.?/i)?.[1]
        ?.replace(/;/g, '; '),
    )
    byFileNo.set(fileNo, { rollNo, pin, legal, assessedCad })
  }
  return byFileNo
}

/** The legal block's file number may carry a municipality prefix
 *  ("YKRH26-002") that the summary card omits ("26-002") — fall back to a
 *  suffix match when it is unambiguous. */
function findLegal(byFileNo: Map<string, LegalInfo>, fileNo: string): LegalInfo | null {
  const exact = byFileNo.get(fileNo)
  if (exact) return exact
  const candidates = [...byFileNo.entries()].filter(([key]) => key.endsWith(fileNo))
  return candidates.length === 1 ? candidates[0]![1] : null
}

export interface Property {
  address: string | null
  minTenderCad: number | null
  fileNo: string | null
  detailUrl: string | null
  photoCount: number
  thumbnailUrl: string | null
  legal: LegalInfo | null
}

/** Sale date comes from the slug (…-YYYY-MM-DD). Tenders on a given page close
 *  at a single stated time ("…will be received until 3:00 p.m."). */
function parseSaleDateTime(
  slugDate: string,
  closeText: string | null,
): { iso: string | null; label: string | null } {
  const dm = slugDate.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!dm) return { iso: null, label: null }
  const [, y, mo, d] = dm
  let hh = '00'
  let mm = '00'
  const tm = closeText?.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m/i)
  if (tm) {
    let h = Number(tm[1])
    const meridiem = tm[3]!.toLowerCase()
    if (meridiem === 'p' && h !== 12) h += 12
    if (meridiem === 'a' && h === 12) h = 0
    hh = String(h).padStart(2, '0')
    mm = tm[2]!
  }
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}${tm ? `, ${hh}:${mm} Uhr` : ''}`,
  }
}

function parseSalePage(html: string, pageUrl: string): { properties: Property[]; dateTime: { iso: string | null; label: string | null } } {
  const $ = load(html)
  const pageText = $('body').text().replace(/\s+/g, ' ')
  const legalByFileNo = parseLegalBlocks(pageText)
  const slugDate = pageUrl.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? ''
  const closeText = pageText.match(/received until[^.]*?\d{1,2}:\d{2}\s*[ap]\.?m/i)?.[0] ?? null
  const dateTime = parseSaleDateTime(slugDate, closeText)

  const properties: Property[] = []
  $('.property-summary').each((_i, section) => {
    const $s = $(section)
    const address = clean($s.find('.p-header .et_pb_text_inner').first().text())
    if (!address) return

    let minTenderCad: number | null = null
    let fileNoRaw: string | null = null
    $s.find('.et_pb_text_inner').each((_j, t) => {
      const txt = clean($(t).text()) ?? ''
      if (/Minimum Tender Amount/i.test(txt)) minTenderCad = parseCadAmount(txt)
      if (/File Number/i.test(txt)) fileNoRaw = txt
    })
    // "File Number: Fort Erie 2026-07-15 24-06" -> the trailing token is the
    // municipality's tax-sale file number, the join key to the legal block.
    // Capture all dash-joined segments so keys like "24-06-01" still match
    // the legal block's File No.
    const fileNo = clean((fileNoRaw ?? '').match(/([\w]+(?:-[\w]+)+)\s*$/)?.[1])

    const detailHref = $s
      .find('a')
      .filter((_k, a) => /more details/i.test($(a).text()))
      .first()
      .attr('href')
    let detailUrl: string | null = null
    if (detailHref) {
      try {
        detailUrl = new URL(detailHref, pageUrl).href
      } catch {
        detailUrl = null
      }
    }

    const captionText = $s.find('.caption').text()
    const photoCount = Number(captionText.match(/(\d+)\s+aerial photos?/i)?.[1] ?? 0)

    const thumbnailUrl =
      clean($s.find('img[src*="/wp-content/uploads/"]').first().attr('src')) ?? null

    properties.push({
      address,
      minTenderCad,
      fileNo,
      detailUrl,
      photoCount: Number.isFinite(photoCount) ? photoCount : 0,
      thumbnailUrl,
      legal: fileNo ? findLegal(legalByFileNo, fileNo) : null,
    })
  })

  return { properties, dateTime }
}

const SQM_PER_ACRE = 4046.86
const SQM_PER_SQFT = 0.092903

/** Fact labels already captured by the listing crawl (address, legal block)
 *  or paywalled ("Available in the InfoPak") — not worth repeating in the
 *  description. */
const SKIPPED_FACT_LABELS = new Set([
  'municipal address',
  'legal description',
  'pin',
  'roll number',
  'annual taxes',
  'assessed value',
  'map',
])

/** Yes/No facts whose label doubles as the property type when "Yes". */
const TYPE_LABELS = new Set(['residential', 'vacant land', 'commercial', 'industrial', 'farmland'])

export interface PropertyDetail {
  title: string | null
  landAreaSqm: number | null
  photoUrls: string[]
  /** Labelled facts ("Property Size: …", "Waterfront: No", …) for description. */
  facts: string[]
  lat: number | null
  lng: number | null
}

/** "Area 0.07ac - Frontage 30ft - Depth 100ft" → m². Prefers the stated
 *  acreage; falls back to frontage × depth when no area is given. */
function parsePropertySize(text: string): number | null {
  const acres = Number(text.match(/area\s*([\d.,]+)\s*ac/i)?.[1]?.replace(/,/g, ''))
  if (Number.isFinite(acres) && acres > 0) return Math.round(acres * SQM_PER_ACRE)
  const frontage = Number(text.match(/frontage\s*([\d.,]+)\s*ft/i)?.[1]?.replace(/,/g, ''))
  const depth = Number(text.match(/depth\s*([\d.,]+)\s*ft/i)?.[1]?.replace(/,/g, ''))
  if (Number.isFinite(frontage) && frontage > 0 && Number.isFinite(depth) && depth > 0) {
    return Math.round(frontage * depth * SQM_PER_SQFT)
  }
  return null
}

/** Parses one /property/ detail page. Facts are rendered as
 *  `<div class="tb-fields-and-text"><strong class="green">Label:</strong>value`
 *  blocks, the photo/aerial gallery as a glide.js slider, and the map pin as a
 *  hidden `<p class="googlemap">{lat,lng}</p>`. */
export function parsePropertyPage(html: string): PropertyDetail {
  const $ = load(html)

  let title: string | null = null
  let landAreaSqm: number | null = null
  const facts: string[] = []
  const titleParts: string[] = []

  $('.tb-fields-and-text').each((_i, el) => {
    const $el = $(el)
    const labelRaw = clean($el.find('strong.green').first().text())
    if (!labelRaw) return
    const label = labelRaw.replace(/:\s*$/, '')
    const value = clean($el.text().replace($el.find('strong.green').first().text(), ''))
    if (!value) return
    const key = label.toLowerCase()
    if (SKIPPED_FACT_LABELS.has(key) || /InfoPak/i.test(value)) return

    if (key === 'property size') {
      landAreaSqm = parsePropertySize(value)
    }
    if (TYPE_LABELS.has(key) && /^yes$/i.test(value)) {
      titleParts.push(label)
    }
    facts.push(`${label}: ${value}`)
  })
  if (titleParts.length > 0) title = titleParts.join(', ')

  // Multi-photo pages render a glide.js slider; single-photo pages inline the
  // one image as `img.main-image` instead.
  const photoUrls = [
    ...new Set(
      $('.glide__slides img[src*="/wp-content/uploads/"], img.main-image[src*="/wp-content/uploads/"]')
        .map((_i, el) => $(el).attr('src'))
        .get()
        .filter((src): src is string => Boolean(src)),
    ),
  ]

  const coordMatch = $('p.googlemap')
    .first()
    .text()
    .match(/\{\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\}/)
  const lat = coordMatch ? Number(coordMatch[1]) : null
  const lng = coordMatch ? Number(coordMatch[2]) : null

  return {
    title,
    landAreaSqm,
    photoUrls,
    facts,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    lng: lng != null && Number.isFinite(lng) ? lng : null,
  }
}

function municipalityFromUrl(pageUrl: string): string {
  const slug = pageUrl.match(/\/tax-sales\/([a-z0-9-]+)-\d{4}-\d{2}-\d{2}/i)?.[1] ?? ''
  return (
    slug
      .split('-')
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' ') || 'Ontario'
  )
}

export function mapProperty(
  prop: Property,
  pageUrl: string,
  municipality: string,
  dateTime: { iso: string | null; label: string | null },
  platformId: string,
): Auction {
  const assessedCad = prop.legal?.assessedCad ?? null

  const externalId =
    clean(prop.detailUrl?.match(/\/property\/([a-z0-9-]+)\/?/i)?.[1]) ??
    (prop.fileNo ? `${municipality}-${prop.fileNo}` : `${municipality}-${prop.address}`)

  const description = [
    prop.minTenderCad != null
      ? `Mindestgebot: ${prop.minTenderCad.toLocaleString('de-DE')} CAD`
      : null,
    prop.legal?.rollNo ? `Roll No.: ${prop.legal.rollNo}` : null,
    prop.legal?.pin ? `PIN: ${prop.legal.pin}` : null,
    prop.legal?.legal,
  ]
    .filter(Boolean)
    .join('\n') || null

  return {
    platform: platformId,
    country: COUNTRY,
    region: 'Ontario',
    externalId,
    caseNumber: prop.fileNo ?? '',
    // Municipal tax sales have no court — the selling authority is the
    // municipality itself.
    authority: municipality,
    title: null,
    address: prop.address,
    // The published "assessed value" is the closest analogue to a Verkehrswert;
    // the minimum tender (tax arrears owed) is kept in description.
    marketValueEur: null,
    marketValue: assessedCad,
    currency: assessedCad != null || prop.minTenderCad != null ? 'CAD' : null,
    marketValueText: assessedCad != null ? `${assessedCad.toLocaleString('de-DE')} CAD (Assessed Value)` : null,
    startingBid: prop.minTenderCad ?? null,
    auctionDateIso: dateTime.iso,
    auctionDateText: dateTime.label,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: prop.detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: prop.detailUrl,
    attachments: [],
    description,
    photoCount: prop.photoCount,
    thumbnailUrl: prop.thumbnailUrl,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const salePages = await discoverSalePages()
  if (salePages.length === 0) return { auctions: [], total: 0 }

  // Fetch first, parse afterwards. The sale pages are large (up to ~650 KB of
  // Divi markup) and cheerio's synchronous parse would otherwise block the
  // event loop mid-crawl, delaying the other workers' in-flight fetches enough
  // to trip their abort timers.
  const html: (string | null)[] = new Array(salePages.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < salePages.length) {
      const i = cursor++
      const url = salePages[i]
      if (!url) continue
      try {
        html[i] = await htmlFetch(url)
      } catch (err) {
        html[i] = null
        console.warn(`ontariotaxsales.ca: fetch failed for ${url}`, err)
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions: Auction[] = []
  for (const [i, url] of salePages.entries()) {
    const page = html[i]
    if (!page || !url) continue
    let parsedPage: ReturnType<typeof parseSalePage>
    try {
      parsedPage = parseSalePage(page, url)
    } catch (err) {
      console.warn(`ontariotaxsales.ca: parse failed for ${url}`, err)
      continue
    }
    const municipality = municipalityFromUrl(url)
    for (const prop of parsedPage.properties) {
      auctions.push(mapProperty(prop, url, municipality, parsedPage.dateTime, platformId))
    }
  }
  return { auctions, total: auctions.length }
}
