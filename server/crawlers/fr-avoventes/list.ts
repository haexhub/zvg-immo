import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import type { PropertyType } from '~/lib/objektart'
import { AV_BASE, UA, COUNTRY } from './constants'
import { areaBucketForPropertyType } from '~/server/utils/extract/rules'

/** Maps the "Type de bien" badge to a representative PropertyType for
 *  areaBucketForPropertyType (its French vocabulary isn't covered by
 *  objektart.ts's conservative cross-language regexes). Defaults to a
 *  residential type — AVOVENTES types are almost always built units, and a
 *  non-land badge should still surface the tile as a living area. */
function typeDeBienPropertyType(typeDeBien: string | null): PropertyType {
  return typeDeBien != null && /terrain/i.test(typeDeBien) ? 'unbebaut' : 'eigentumswohnung'
}

const DETAIL_CONCURRENCY = 4
const FETCH_RETRIES = 2
const AV_ORIGIN = new URL(AV_BASE).origin

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

function parseListPage(html: string): { items: ListItem[]; rawCount: number; totalReported: number | null } {
  const $ = load(html)
  const items: ListItem[] = []
  let rawCount = 0

  $('[data-link^="https://avoventes.fr/enchere/"]').each((_i, el) => {
    const $card = $(el)
    const href = $card.attr('data-link')
    if (!href) return
    rawCount++
    // The `type_vente=encheres` query param doesn't fully exclude "Vente
    // amiable" (privately negotiated, non-auction) rows — a few still slip
    // in, badged "Vente amiable" instead of "Vente aux enchères" and with no
    // "Date de la vente" field at all. Those aren't Zwangsversteigerungen, so
    // skip them here rather than relying on the upstream filter. Counted via
    // rawCount above (not `items.length`) so the totalReported sanity check
    // below isn't tripped by this deliberate exclusion.
    const badge = clean($card.find('.badge').first().text())
    if (!/vente aux enchères/i.test(badge)) return
    const text = clean($card.text())
    // A re-auction after a "surenchère" (overbid) drops the "initiale" and
    // shows the new starting price as plain "Mise à prix : X €".
    const priceM = text.match(/Mise à prix(?:\s+initiale)?\s*:\s*([\d\s.,]+)\s*€/)
    // Non-greedy up to "Date des visites" when present, but a listing with no
    // scheduled visit wouldn't have that label at all — fall back to the end
    // of the (already single-line, whitespace-collapsed) card text instead of
    // failing the match outright, which would otherwise leave terminIso null
    // and keep the row forever (an unknown-date row is always kept, see the
    // date filter in fetchAllListings below).
    const dateM = text.match(/Date de la vente\s*:\s*(.+?)(?:\s*Date des visites|$)/)
    const terminText = dateM ? clean(dateM[1]!) : null
    const priceText = priceM ? clean(priceM[1]!) : null
    const adresse = clean($card.find('.mt-2.d-flex div.inline-block').last().text()) || null

    items.push({
      href,
      objekt: clean($card.find('.font-bold.text-16.mb-2').first().text()) || null,
      // Drop the trailing ", France" — every row is French, it's just noise.
      adresse: adresse ? adresse.replace(/,?\s*France\.?\s*$/i, '') : null,
      priceEur: priceText ? parseEurAmount(`${priceText} €`) : null,
      priceText: priceText ? `${priceText} €` : null,
      terminIso: parseFrDateTime(terminText),
      terminText,
    })
  })

  const totalM = $('.font-light.text-16.text-muted').first().text().match(/(\d+)/)
  return { items, rawCount, totalReported: totalM ? Number(totalM[1]) : null }
}

interface DetailInfo {
  beschreibung: string | null
  photos: string[]
  /** "Type de bien" badge next to the "Vente aux enchères" one. */
  typeDeBien: string | null
  /** Stat tiles under the price block: "pièces" / "m² superficie" (the
   *  superficie is the surface habitable — land-with-house listings show the
   *  house's living area there, not the plot). For bare-land types ("Terrain",
   *  "Terrain à bâtir") the tile carries the plot size instead, so the value
   *  is bucketed into landAreaSqm. */
  rooms: number | null
  livingAreaSqm: number | null
  landAreaSqm: number | null
}

export function parseDetailPage(html: string): DetailInfo {
  const $ = load(html)
  const beschreibung = clean($('.font-light.mb-4').first().text()) || null
  const photos = $('#lightSliderDetails .selector')
    .map((_i, el) => $(el).attr('data-src'))
    .get()
    .filter((src): src is string => Boolean(src))

  // First badge is the sale type ("Vente aux enchères"), the secondary badge
  // carries the type de bien ("Appartement", "Maison", …).
  const typeDeBien = clean($('.badge.badge-secondary').first().text()) || null

  let rooms: number | null = null
  let superficie: number | null = null
  $('span.font-weight-bold.h4').each((_i, el) => {
    const $el = $(el)
    // Values may group thousands with spaces ("1 200" m² plots) — strip them
    // before parsing.
    const value = Number(clean($el.text()).replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) return
    const label = clean($el.parent().find('.small.text-muted').first().text()).toLowerCase()
    // "pièces", or singular "pièce" on one-room lots.
    if (label.startsWith('pièce')) rooms = value
    else if (label.includes('superficie')) superficie = value
  })
  const bucket = areaBucketForPropertyType(typeDeBienPropertyType(typeDeBien))

  return {
    beschreibung,
    photos,
    typeDeBien,
    rooms,
    livingAreaSqm: bucket === 'living' ? superficie : null,
    landAreaSqm: bucket === 'land' ? superficie : null,
  }
}

async function fetchDetail(href: string): Promise<DetailInfo | null> {
  // The origin check must stay inside the try — thrown outside it, it would
  // reject the calling worker's Promise.all in fetchAllListings and zero out
  // every listing for one malformed href instead of just skipping that row.
  try {
    const url = new URL(href)
    if (url.origin !== AV_ORIGIN) {
      throw new Error(`Unexpected detail URL origin: ${url.origin}`)
    }
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

  // Surface the structured detail facts as labelled lines ahead of the
  // free-text description.
  const facts = [
    detail?.typeDeBien ? `Type de bien : ${detail.typeDeBien}` : null,
    detail?.rooms != null ? `Pièces : ${detail.rooms}` : null,
    detail?.livingAreaSqm != null ? `Superficie : ${detail.livingAreaSqm} m²` : null,
  ].filter(Boolean)
  const beschreibung =
    [facts.join('\n'), detail?.beschreibung].filter(Boolean).join('\n\n') || null

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
    // d'avocats" handling the sale, which isn't the court) — 'Avoventes' is
    // the platform, not a court, and must not be stored here.
    amtsgericht: '',
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
    beschreibung,
    fotoCount: photos.length,
    thumbnailUrl: photos[0] ?? null,
    ...(photos.length > 0 ? { photoUrls: photos } : {}),
    ...(detail?.rooms != null ? { sourceRooms: detail.rooms } : {}),
    ...(detail?.livingAreaSqm != null ? { sourceLivingAreaSqm: detail.livingAreaSqm } : {}),
    ...(detail?.landAreaSqm != null ? { sourceLandAreaSqm: detail.landAreaSqm } : {}),
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const { items: allItems, rawCount, totalReported } = parseListPage(await htmlFetch(SEARCH_URL))
  if (totalReported != null && totalReported !== rawCount) {
    console.warn(
      `avoventes.fr: page reports ${totalReported} résultats but parsed ${rawCount} cards — selector may be stale`,
    )
  }

  // The search has no "upcoming only" filter — it mixes genuinely future
  // sales with ones already past their audience date (still listed during
  // the ~10-day post-sale "surenchère" window). Keep only future/unknown-date
  // rows so this source behaves like every other crawler's "prochaines
  // ventes" list. terminIso is French local time, so "today" must be derived
  // in Europe/Paris too — UTC would keep yesterday's already-past auctions
  // for a couple of hours after midnight in France.
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
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
