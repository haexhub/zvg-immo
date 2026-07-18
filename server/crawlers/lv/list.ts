import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { LV_BASE, COUNTRY, UA, FILTER_BODY, MAX_LIST_PAGES } from './constants'
import { clean, parseLvPrice, cellText, parseLvDateTime, htmlToText } from './text'

function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>(
    existing
      .split('; ')
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf('=')
        return [c.slice(0, eq), c.slice(eq + 1)] as [string, string]
      }),
  )
  for (const entry of setCookieHeaders) {
    const pair = (entry.split(';')[0] ?? '').trim()
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** The search form's "Atrast" button has no type="submit" — a real click runs
 *  a jQuery submit(), so a plain GET/POST with query params is ignored by the
 *  server. Submitting the filter fields via POST once sets them in the
 *  session (ci_session cookie, returned via Set-Cookie on the redirect); every
 *  subsequent page fetch just needs to send that cookie back. */
async function establishFilterSession(): Promise<string> {
  const res = await fetch(`${LV_BASE}/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
    },
    body: new URLSearchParams(FILTER_BODY).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length === 0) {
    throw new Error('izsoles.ta.gov.lv: filter POST returned no session cookie')
  }
  return mergeCookies('', setCookie)
}

function parseListPage(html: string, platformId: string): Auction[] {
  const $ = load(html)
  const auctions: Auction[] = []

  $('table.auction-list tbody tr').each((_, tr) => {
    const $tr = $(tr)

    const $link = $tr.find('.auction-list-address a').first()
    const href = $link.attr('href') ?? ''
    const uuid = href.match(/izsole\/([a-f0-9-]{36})/)?.[1]
    if (!uuid) return

    const type = clean($tr.find('td.__type').first().text())
    if (type && !type.toLowerCase().includes('nekustam')) return

    const address = clean($link.text())
    const thumbnailUrl = $tr.find('img.thumb').first().attr('src') ?? null

    const numberCells = $tr.find('td.number')
    const valuationCell = numberCells.filter((_, el) => !$(el).hasClass('__start_price')).first()
    const startPriceCell = numberCells.filter((_, el) => $(el).hasClass('__start_price')).first()
    const marketValueText = clean(valuationCell.text())
    const startPriceText = clean(startPriceCell.text())

    const state = clean($tr.find('td.__state').first().text()) ?? ''
    const bailiff = clean($tr.find('td.__bailiff').first().text())

    const startRaw = cellText($tr.find('td.__start_time').first().html())
    const endRaw = cellText($tr.find('td.__end_time').first().html())
    const { iso: auctionDateIso, label: auctionDateText } = parseLvDateTime(endRaw)

    const descHtml = $tr.find('.auction-info .hidden').first().text()
    const description = descHtml
      ? [startPriceText ? `Sākumcena: ${startPriceText}` : null, htmlToText(descHtml)]
          .filter(Boolean)
          .join('\n\n') || null
      : null

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: '',
      externalId: uuid,
      caseNumber: '',
      authority: bailiff ?? '',
      title: null,
      address,
      marketValueEur: parseLvPrice(marketValueText),
      marketValueText,
      auctionDateIso,
      auctionDateText: auctionDateText ?? (startRaw ? `Beginn: ${startRaw}` : null),
      cancelled: !state.toLowerCase().includes('notiek'),
      sourceUpdatedIso: null,
      pdfUrl: null,
      detailUrl: `${LV_BASE}/izsole/${uuid}`,
      pdfUrlUpstream: null,
      detailUrlUpstream: `${LV_BASE}/izsole/${uuid}`,
      attachments: [],
      description,
      photoCount: thumbnailUrl ? 1 : 0,
      thumbnailUrl,
    })
  })

  return auctions
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const cookie = await establishFilterSession()
  const auctions: Auction[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const url = page === 1 ? `${LV_BASE}/` : `${LV_BASE}/${page}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'lv,en;q=0.9',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      if (auctions.length > 0) break
      throw new Error(`izsoles.ta.gov.lv fetch failed: ${res.status} ${url}`)
    }
    /** Out-of-range page numbers are clamped to the last page instead of
     *  returning an empty list, so stop as soon as a page adds nothing new. */
    const pageAuctions = parseListPage(await res.text(), platformId).filter(
      (a) => !seen.has(a.externalId),
    )
    if (pageAuctions.length === 0) break
    for (const a of pageAuctions) seen.add(a.externalId)
    auctions.push(...pageAuctions)
  }

  return { auctions, total: auctions.length }
}
