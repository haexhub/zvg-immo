import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { PL_BASE, LIST_PATH, LIST_PAGE_SIZE, COUNTRY, UA } from './constants'
import { parsePlDate, clean } from './text'

export interface ParseResult {
  auctions: Auction[]
  /** 1-based page currently shown, taken from the pagination widget. */
  currentPage: number | null
  /** Last page number shown in the pagination widget. */
  lastPage: number | null
  hasNextPage: boolean
}

/** Fetch one SSR list page (sorted newest-first by publication date). */
export async function fetchListPage(offset: number, platformId: string): Promise<ParseResult> {
  const params = new URLSearchParams({ mainCategory: 'REAL_ESTATE', limit: String(LIST_PAGE_SIZE) })
  if (offset > 0) params.set('offset', String(offset))

  const url = `${PL_BASE}${LIST_PATH}?${params}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`PL list fetch failed: ${res.status} ${url}`)
  const html = await res.text()
  // A WAF/error page can still answer HTTP 200 — without this check it would
  // parse into a silent, successful empty page and suppress retries.
  if (!html.includes('id="item-list-container"')) {
    throw new Error(`PL list fetch returned unexpected page (WAF/error?): ${url}`)
  }

  return parseListHtml(html, platformId)
}

/**
 * Parse a licytacje.komornik.pl search page (Nuxt SSR).
 *
 * Each listing is an <a class="notice" href="/wyszukiwarka/obwieszczenia-o-licytacji/<id>/<slug>">
 * card with .notice__title / .notice__province / .notice__address / .notice__date children.
 * Prices and photos are NOT part of the SSR list markup (they are lazy-loaded
 * client-side) — verkehrswert is filled in by enrichOne from the detail page.
 */
export function parseListHtml(html: string, platformId: string): ParseResult {
  const $ = load(html)
  const auctions: Auction[] = []

  $('a.notice[href*="/wyszukiwarka/obwieszczenia-o-licytacji/"]').each((_i, card) => {
    const c = $(card)
    const href = c.attr('href') ?? ''
    const idMatch = href.match(/obwieszczenia-o-licytacji\/(\d+)(?:[/?#]|$)/)
    const noticeId = idMatch?.[1] ?? null
    if (!noticeId) return

    const titel = clean(c.find('.notice__title').text())
    const province = clean(c.find('.notice__province div').text())
    const address = clean(c.find('.notice__address div').text())
    // "Początek: 10.09.2026 11:00" — strip the label, keep date + time
    const dateRaw = clean(c.find('.notice__date div').first().text()).replace(/^Początek:\s*/i, '')

    const detailUrlUpstream = `${PL_BASE}${href}`

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: province ? province.charAt(0).toUpperCase() + province.slice(1) : '',
      externalId: noticeId,
      // The real Aktenzeichen (Sygnatura) only exists on the detail page and
      // is filled in by enrichOne. Leave the list value empty — a non-empty
      // placeholder (the notice id already lives in externalId) would survive
      // the snapshot merge and clobber the enriched Sygnatura on every re-crawl.
      caseNumber: '',
      authority: '',
      title: titel || null,
      // Cards without an address line still carry the województwo — a
      // region-level address keeps the listing geocodable/mappable.
      address: address ? `${address}, Polen` : province ? `${province}, Polen` : null,
      marketValueEur: null,
      marketValueText: null,
      auctionDateIso: parsePlDate(dateRaw),
      auctionDateText: dateRaw || null,
      cancelled: false,
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

  // Vuetify pagination: numbered items, the active one carries --is-active.
  const pageNumbers = $('.v-pagination__item')
    .map((_i, el) => parseInt($(el).text().trim(), 10))
    .get()
    .filter((n) => !isNaN(n))
  const lastPage = pageNumbers.length ? Math.max(...pageNumbers) : null
  const activeRaw = parseInt($('.v-pagination__item--is-active').first().text().trim(), 10)
  const currentPage = isNaN(activeRaw) ? null : activeRaw

  const hasNextPage = currentPage != null && lastPage != null && currentPage < lastPage

  return { auctions, currentPage, lastPage, hasNextPage }
}
