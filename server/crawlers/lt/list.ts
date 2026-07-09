import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { LT_BASE, LIST_PATH, COUNTRY, UA } from './constants'
import { parseLtDate, parseLtPrice, clean } from './text'

/**
 * Each <li> in ul.bid_list represents one auction. Structure:
 *   a.foto [img]           → thumbnail (optional)
 *   .top_block h2.no a     → detail href ?id=NNN&number=MMM
 *   ul.desc li[span=Pabaiga:] → end date text "2026-07-09 12:59"
 *   ul.desc li.sep         → starting price " 39 168 Eur"
 *   .list_box ul.list li   → property description + optional span.small (address)
 */
function parsePage(html: string, platformId: string): { auctions: Auction[]; hasMore: boolean } {
  const $ = load(html)
  const auctions: Auction[] = []

  $('ul.bid_list > li').each((_, li) => {
    const $li = $(li)

    const href = $li.find('.top_block h2.no a').attr('href') ?? ''
    const id = href.match(/[?&]id=(\d+)/)?.[1]
    const number = href.match(/[?&]number=(\d+)/)?.[1]
    if (!id || !number) return

    const imgSrc = $li.find('a.foto img').attr('src') ?? null
    const thumbnailUrl = imgSrc ? `${LT_BASE}${imgSrc}` : null

    let terminRaw = ''
    $li.find('ul.desc li').each((_, descLi) => {
      if ($(descLi).find('span.txt').text().includes('Pabaiga:')) {
        terminRaw = clean($(descLi).text()).replace('Pabaiga:', '').trim()
      }
    })

    const priceEur = parseLtPrice(
      $li.find('ul.desc li.sep').contents().filter((_, n) => n.type === 'text').text(),
    )

    const $firstItem = $li.find('.list_box ul.list li').first()
    const adresse = clean($firstItem.find('span.small').first().text()) || null
    const objekt = clean($firstItem.clone().find('span, br').remove().end().text()) || null

    const detailUrl = `${LT_BASE}/evs/pages/auction.do?id=${id}&number=${number}`

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: '',
      zvgId: id,
      aktenzeichen: number ?? id,
      amtsgericht: '',
      objekt,
      adresse,
      verkehrswertEur: priceEur,
      verkehrswertText: priceEur != null ? `${priceEur.toLocaleString('de-DE')} €` : null,
      terminIso: parseLtDate(terminRaw),
      terminText: terminRaw || null,
      aufgehoben: false,
      letzteAktualisierungIso: null,
      pdfUrl: null,
      detailUrl,
      pdfUrlUpstream: null,
      detailUrlUpstream: detailUrl,
      attachments: [],
      beschreibung: null,
      fotoCount: thumbnailUrl ? 1 : 0,
      thumbnailUrl,
    })
  })

  return { auctions, hasMore: auctions.length >= 20 }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const allAuctions: Auction[] = []
  const MAX_PAGES = 100

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${LT_BASE}${LIST_PATH}${page}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'lt,en;q=0.9' },
    })
    if (!res.ok) {
      // Treat failure on a probe request (we have data, just checking if there's more)
      // as end-of-pages rather than discarding all already-collected auctions.
      if (allAuctions.length > 0) break
      throw new Error(`eaukcionai.lt fetch failed: ${res.status} ${url}`)
    }

    const { auctions, hasMore } = parsePage(await res.text(), platformId)
    allAuctions.push(...auctions)
    if (!hasMore) break
  }

  return { auctions: allAuctions, total: null }
}
