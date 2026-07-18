import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { AT_BASE, COUNTRY, PORTAL_BL_CODES, AT_REGION_NAMES, UA } from './constants'
import { formatAtDate, parseAustrianDateTime, stripHtml } from './text'

export interface ParseResult {
  totalReported: number | null
  auctions: Auction[]
}

const FETCH_TIMEOUT_MS = 20_000

/**
 * Builds the advanced-search URL for one Bundesland over a date window. The
 * portal renders all hits on one page up to `SearchMax=4999`; 18 months
 * forward currently yields under 500 entries country-wide, well within that.
 */
export function buildSearchUrl(
  regionCode: string,
  dateFrom: Date,
  dateTo: Date,
): string {
  const bl = PORTAL_BL_CODES[regionCode]
  if (!bl) throw new Error(`Unknown AT region code: ${regionCode}`)
  const params = new URLSearchParams()
  params.append('OpenAgent', '')
  params.append('subf', 'vex')
  params.append('scope', 'edi')
  params.append('BL', bl)
  params.append('VVDat1', formatAtDate(dateFrom))
  params.append('VVDat2', formatAtDate(dateTo))
  params.append('sebut', '   Suchen   ')
  return `${AT_BASE}/edikte/ex/exedi3.nsf/submitSuche?${params.toString()}`
}

export async function fetchListHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-AT,de;q=0.9',
      },
    })
    if (!res.ok) throw new Error(`AT listing HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

const UNID_RE = /alldoc\/([a-f0-9]+)/i

/** Whitespace-normalises a listing-cell address ("1230 Wien Otto-Mauer-Gasse 10").
 *  We can't reliably split PLZ/Ort from the street here — Austrian localities
 *  routinely contain multiple words ("Sankt Johann im Pongau", "Bad Ischl"),
 *  so a "PLZ + first word = Ort" heuristic corrupts those. Detail enrichment
 *  later replaces this with the structured "Strasse, PLZ Ort" form anyway. */
function formatAddressLine(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  return cleaned || null
}

/**
 * Parses one results page. The portal renders a single `<table>` with one
 * `<tr>` per Edikt. Per row:
 *   - cell 1: counter span (skip)
 *   - cell 2: `data-sort="DD.MM.YYYY"` + `<a href="alldoc/<UNID>!OpenDocument">Status text (date)</a>`
 *   - cell 3: `PLZ Ort Strasse<br>Objektkategorie`
 *   - cell 4: short title / additional description
 */
export function parseListingHtml(
  html: string,
  regionCode: string,
  platformId: string,
): ParseResult {
  const $ = load(html)
  const auctions: Auction[] = []
  const regionName = AT_REGION_NAMES[regionCode] ?? regionCode

  const totalMatch = html.match(/id="treffer">\s*(\d+)/)
  const totalReported = totalMatch?.[1] ? parseInt(totalMatch[1], 10) : null

  $('table.table tbody tr, table.table tr').each((_i, el) => {
    const $row = $(el)
    const cells = $row.find('> td')
    if (cells.length < 3) return

    const dateCell = cells.eq(1)
    const dataSort = dateCell.attr('data-sort') ?? ''
    const link = dateCell.find('a').first()
    const href = link.attr('href') ?? ''
    const unidMatch = href.match(UNID_RE)
    if (!unidMatch?.[1]) return
    const unid = unidMatch[1]
    const statusText = link.text().trim()
    // "Verschiebung (von 03.07.2026 auf 23.09.2026)" — data-sort still holds
    // the original date; the effective one is the LAST date in the status.
    // For "Versteigerung (DD.MM.YYYY)" and "Entfall (DD.MM.YYYY)" this is
    // equivalent to data-sort but works without that attribute too.
    const dateMatches = [...statusText.matchAll(/(\d{2}\.\d{2}\.\d{4})/g)]
    const effectiveDate = dateMatches.at(-1)?.[1] ?? dataSort

    // Status prefix decides whether we treat the appointment as cancelled.
    // "Entfall des Termins" is the portal's wording for a cancelled date;
    // "Verschiebung" just rescheduled — data-sort already reflects the new
    // date, so we keep cancelled=false there.
    const cancelled = /^Entfall/i.test(statusText)

    // Cell 3: "PLZ Ort Strasse<br>Kategorie" (Kategorie is the second line).
    const addrCellHtml = cells.eq(2).html() ?? ''
    const [addrPart = '', kategoriePart = ''] = addrCellHtml
      .split(/<br\s*\/?>/i)
      .map((s) => stripHtml(s))
    const address = formatAddressLine(addrPart)
    const title = (cells.eq(3).text().trim() || kategoriePart.trim()) || null

    const detailUrlUpstream = `${AT_BASE}/edikte/ex/exedi3.nsf/alldoc/${unid}!OpenDocument`

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: regionName,
      externalId: unid,
      // Listing has no structured Aktenzeichen; detail enrichment fills it.
      caseNumber: '',
      authority: '',
      title,
      address,
      marketValueEur: null,
      marketValueText: null,
      auctionDateIso: parseAustrianDateTime(effectiveDate),
      auctionDateText: statusText || dataSort || null,
      cancelled,
      sourceUpdatedIso: null,
      pdfUrl: null,
      detailUrl: detailUrlUpstream,
      pdfUrlUpstream: null,
      detailUrlUpstream,
      attachments: [],
      description: null,
      photoCount: 0,
      thumbnailUrl: null,
    })
  })

  // Defensive dedup by UNID — the portal occasionally repeats rows when an
  // Edikt is amended (the new and old revisions briefly coexist).
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.externalId)) return false
    seen.add(a.externalId)
    return true
  })

  return { totalReported, auctions: unique }
}
