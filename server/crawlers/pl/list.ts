import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { PL_BASE, COUNTRY, UA } from './constants'
import { parsePlDate, parsePlPrice, clean } from './text'

export interface ParseResult {
  auctions: Auction[]
  totalReported: number | null
  hasNextPage: boolean
}

/** Fetch one filter page. sortOrder keeps newest-first. */
export async function fetchFilterPage(
  filterId: number,
  page: number,
  platformId: string,
): Promise<ParseResult> {
  const params = new URLSearchParams()
  params.set('sortOrder', 'DataLicytacji Desc')
  if (page > 1) params.set('page', String(page))

  const url = `${PL_BASE}/Notice/Filter/${filterId}?${params}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`PL list fetch failed: ${res.status} ${url}`)
  const html = await res.text()

  return parseFilterHtml(html, platformId)
}

/**
 * Parse a licytacje.komornik.pl filter page rendered by Nuxt+Vuetify.
 *
 * The Vuetify v-data-table renders a standard <table> in SSR mode.
 * Column order (0-based): Lp. | Foto | Data licytacji | Nazwa | Miasto | Cena | Elektroniczna
 *
 * TODO: verify selectors against a live page with actual listings.
 */
export function parseFilterHtml(html: string, platformId: string): ParseResult {
  const $ = load(html)
  const auctions: Auction[] = []

  // Total count — Nuxt app may render a string like "Znaleziono: 123 ogłoszeń"
  const totalMatch = html.match(/(\d+)\s+og[łl]oszeń/i) ?? html.match(/Znaleziono[^0-9]*(\d+)/i)
  const totalReported = totalMatch ? parseInt(totalMatch[1], 10) : null

  // Vuetify SSR table: look for tbody rows inside .v-data-table, fallback to any table.
  const rows = $('.v-data-table table tbody tr, table.notice-list tbody tr, table tbody tr').filter(
    (_i, el) => $(el).find('td').length >= 4,
  )

  rows.each((_i, row) => {
    const tds = $(row).find('td')

    // Column mapping — adjust indices if the live page differs:
    // 0: Lp. (row number — skip)
    // 1: Foto (img tag — url for thumbnail)
    // 2: Data licytacji
    // 3: Nazwa (name + detail link)
    // 4: Miasto / Województwo
    // 5: Cena wywołania
    // 6: Elektroniczna (bool — skip for now)

    const dateRaw = clean(tds.eq(2).text())
    const nazwaEl = tds.eq(3)
    const nazwa = clean(nazwaEl.text())
    const miastoRaw = clean(tds.eq(4).text())
    const cenaRaw = clean(tds.eq(5).text())

    // Detail link: <a href="/Notice/Details/12345"> inside the Nazwa cell.
    const linkEl = nazwaEl.find('a[href*="/Notice/"]').first()
    const href = linkEl.attr('href') ?? ''
    // Extract numeric id from the href, e.g. /Notice/Details/12345
    const idMatch = href.match(/\/(\d+)(?:[/?#]|$)/)
    const noticeId = idMatch?.[1] ?? null
    if (!noticeId) return // skip rows without a parseable id

    const terminIso = parsePlDate(dateRaw)

    // "Kraków / Małopolskie" or "Kraków Małopolskie" — split on / or whitespace boundary
    const [miasto, ...rest] = miastoRaw.split(/\s*\/\s*|\s{2,}/)
    const wojewodztwo = rest.join(' ').trim() || null

    const adresse = [nazwa && !nazwa.includes(miasto ?? '') ? nazwa : null, miasto, 'Polen']
      .filter(Boolean)
      .join(', ')

    const thumbnailEl = tds.eq(1).find('img').first()
    const thumbnailSrc = thumbnailEl.attr('src') ?? null
    const thumbnailUrl = thumbnailSrc
      ? thumbnailSrc.startsWith('http')
        ? thumbnailSrc
        : `${PL_BASE}${thumbnailSrc}`
      : null

    const detailUrlUpstream = `${PL_BASE}/Notice/Details/${noticeId}`

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: wojewodztwo ?? miasto ?? '',
      zvgId: noticeId,
      aktenzeichen: noticeId,
      amtsgericht: '',
      objekt: nazwa || null,
      adresse: adresse || null,
      verkehrswertEur: parsePlPrice(cenaRaw),
      verkehrswertText: cenaRaw || null,
      terminIso,
      terminText: dateRaw || null,
      aufgehoben: false,
      letzteAktualisierungIso: null,
      pdfUrl: null,
      detailUrl: detailUrlUpstream,
      pdfUrlUpstream: null,
      detailUrlUpstream,
      attachments: [],
      beschreibung: null,
      fotoCount: thumbnailUrl ? 1 : 0,
      thumbnailUrl,
    })
  })

  // Next-page indicator: Vuetify pagination renders aria-label="Next page" or a disabled "next" btn.
  const hasNextPage =
    $('[aria-label="Next page"]:not([disabled])').length > 0 ||
    $('a.next-page, .v-pagination__next:not(.v-btn--disabled)').length > 0

  return { auctions, totalReported, hasNextPage }
}
