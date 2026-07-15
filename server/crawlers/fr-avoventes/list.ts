import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { AV_BASE, UA, COUNTRY } from './constants'

const DETAIL_CONCURRENCY = 4
const FETCH_RETRIES = 2

/** Unfiltered search covers "Ventes amiables" (privately negotiated, court-
 *  supervised sales) too, which aren't public-bid Zwangsversteigerungen —
 *  restrict to "Enchères" only. The search has no visible pagination; at the
 *  current national volume (~50 rows) everything renders on one page. */
const SEARCH_URL = `${AV_BASE}/recherche/toutes?type_vente=encheres&sort=date&order=asc&display=liste`

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** French amounts are formatted like "210 000,00 €" (space thousands
 *  separator, comma decimals). */
function parseEurAmount(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/([\d\s.,]+)\s*€/)
  if (!m) return null
  const n = Number(m[1]!.replace(/[\s.]/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

const FR_MONTHS: Record<string, number> = {
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
}

/** Parses "mardi 07 juillet 2026 à 14h00" (list) or "07 juillet 2026 à
 *  10h30" (detail) into a naive local ISO string — same convention as
 *  licitor's own `<time datetime>` (no UTC offset attached). */
function parseFrDateTime(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/(\d{1,2})(?:er)?\s+([a-zûéèêîôç]+)\s+(\d{4})(?:\s*[àa]\s*(\d{1,2})h(\d{2})?)?/i)
  if (!m) return null
  const month = FR_MONTHS[m[2]!.toLowerCase()]
  if (!month) return null
  const day = m[1]!.padStart(2, '0')
  const mo = String(month).padStart(2, '0')
  const hh = (m[4] ?? '0').padStart(2, '0')
  const mm = (m[5] ?? '0').padStart(2, '0')
  return `${m[3]}-${mo}-${day}T${hh}:${mm}:00`
}

/** Retries transient failures (timeout, network error, 5xx) so a single blip
 *  doesn't zero out the whole national list until the next crawl cycle. 4xx
 *  responses are not retried — they won't succeed on a second attempt. */
async function htmlFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'fr,en;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`avoventes.fr ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`avoventes.fr ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {}) // drain body to avoid socket leak on retried 5xx
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

interface ListItem {
  href: string
  objekt: string | null
  adresse: string | null
  priceEur: number | null
  priceText: string | null
  terminIso: string | null
  terminText: string | null
}

function parseListPage(html: string): { items: ListItem[]; totalReported: number | null } {
  const $ = load(html)
  const items: ListItem[] = []

  $('[data-link^="https://avoventes.fr/enchere/"]').each((_i, el) => {
    const $card = $(el)
    const href = $card.attr('data-link')
    if (!href) return
    const text = clean($card.text())
    // A re-auction after a "surenchère" (overbid) drops the "initiale" and
    // shows the new starting price as plain "Mise à prix : X €".
    const priceM = text.match(/Mise à prix(?:\s+initiale)?\s*:\s*([\d\s.,]+)\s*€/)
    const dateM = text.match(/Date de la vente\s*:\s*(.+?)\s*Date des visites/)
    const terminText = dateM ? clean(dateM[1]!) : null
    const adresse = clean($card.find('.mt-2.d-flex div.inline-block').last().text()) || null

    items.push({
      href,
      objekt: clean($card.find('.font-bold.text-16.mb-2').first().text()) || null,
      // Drop the trailing ", France" — every row is French, it's just noise.
      adresse: adresse ? adresse.replace(/,\s*France\s*$/i, '') : null,
      priceEur: priceM ? parseEurAmount(priceM[0]) : null,
      priceText: priceM ? `${clean(priceM[1]!)} €` : null,
      terminIso: parseFrDateTime(terminText),
      terminText,
    })
  })

  const totalM = $('.font-light.text-16.text-muted').first().text().match(/(\d+)/)
  return { items, totalReported: totalM ? Number(totalM[1]) : null }
}

interface DetailInfo {
  beschreibung: string | null
  photos: string[]
}

function parseDetailPage(html: string): DetailInfo {
  const $ = load(html)
  const beschreibung = clean($('.font-light.mb-4').first().text()) || null
  const photos = $('#lightSliderDetails .selector')
    .map((_i, el) => $(el).attr('data-src'))
    .get()
    .filter((src): src is string => Boolean(src))
  return { beschreibung, photos }
}

async function fetchDetail(href: string): Promise<DetailInfo | null> {
  const url = new URL(href)
  if (url.origin !== new URL(AV_BASE).origin) {
    throw new Error(`Unexpected detail URL origin: ${url.origin}`)
  }
  try {
    return parseDetailPage(await htmlFetch(url.toString()))
  } catch {
    return null
  }
}

function idFromHref(href: string): string {
  return href.split('/').filter(Boolean).pop() ?? href
}

function mapItem(item: ListItem, detail: DetailInfo | null, platformId: string): Auction {
  const photos = detail?.photos ?? []
  const attachments: Attachment[] = []

  return {
    platform: platformId,
    country: COUNTRY,
    // AVOVENTES exposes no sub-region filter either — see FR_AVOVENTES_REGIONS.
    region: '',
    zvgId: idFromHref(item.href),
    // Like licitor, AVOVENTES never publishes the court's own case number
    // (no "RG n°") on the listing or detail page — must not be filled with
    // an internal id (see licitor's PR #53 review lesson).
    aktenzeichen: '',
    // No court/tribunal name is exposed either (only the "cabinet
    // d'avocats" handling the sale, which isn't the court).
    amtsgericht: 'Avoventes',
    objekt: item.objekt,
    adresse: item.adresse,
    verkehrswertEur: item.priceEur,
    verkehrswertText: item.priceText,
    terminIso: item.terminIso,
    terminText: item.terminText,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: item.href,
    pdfUrlUpstream: null,
    detailUrlUpstream: item.href,
    attachments,
    beschreibung: detail?.beschreibung ?? null,
    fotoCount: photos.length,
    thumbnailUrl: photos[0] ?? null,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const { items: allItems, totalReported } = parseListPage(await htmlFetch(SEARCH_URL))
  if (totalReported != null && totalReported !== allItems.length) {
    console.warn(
      `avoventes.fr: page reports ${totalReported} résultats but parsed ${allItems.length} — selector may be stale`,
    )
  }

  // The search has no "upcoming only" filter — it mixes genuinely future
  // sales with ones already past their audience date (still listed during
  // the ~10-day post-sale "surenchère" window). Keep only future/unknown-date
  // rows so this source behaves like every other crawler's "prochaines
  // ventes" list. Compared as plain date strings to sidestep timezone drift
  // around midnight.
  const todayStr = new Date().toISOString().slice(0, 10)
  const items = allItems.filter((item) => !item.terminIso || item.terminIso.slice(0, 10) >= todayStr)

  if (items.length === 0) return { auctions: [], total: 0 }

  const details: (DetailInfo | null)[] = new Array(items.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      if (!item) continue
      details[i] = await fetchDetail(item.href)
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = items.map((item, i) => mapItem(item, details[i] ?? null, platformId))
  return { auctions, total: auctions.length }
}
