import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { UA } from './constants'
import { parsePlPrice, parseLivingAreaSqm, formatPln, clean } from './text'

export interface DetailData {
  beschreibung: string | null
  aktenzeichen: string | null
  /** "Sąd Rejonowy w <Miasto>" — the executing court, independent of the Sygnatura. */
  amtsgericht: string | null
  /** "Suma oszacowania" — the court-appraised value (= Verkehrswert), in PLN. */
  sumaOszacowaniaPln: number | null
  /** "Cena wywołania" — the opening bid, in PLN. Fallback when no Suma is given. */
  cenaWywolaniaPln: number | null
  livingAreaSqm: number | null
}

/**
 * Parse the SSR detail page ("obwieszczenie" template): the free-text lot
 * description lives in .template-item-title, the structured values in
 * .template-item-attribute label/value pairs. Photos are lazy-loaded via a
 * WAF-guarded JSON API and are therefore not extracted here.
 */
export function parseDetailHtml(html: string): DetailData {
  const $ = load(html)

  // Lot description: <h4>lokal mieszkalny</h4> followed by free text.
  const titleEl = $('.template-item-title .template-item-value').first().clone()
  titleEl.find('h4').remove()
  const beschreibung = clean(titleEl.text()) || null

  // Structured attributes: label → value. Prefix match — labels carry
  // footnote markers on some notices ("Cena wywołania*").
  const attrs: Array<[string, string]> = []
  $('.template-item-attribute').each((_i, el) => {
    const label = clean($(el).find('.template-item-label').text())
    const value = clean($(el).find('.template-item-value').text())
    if (label) attrs.push([label, value])
  })
  const attr = (prefix: string) => attrs.find(([label]) => label.startsWith(prefix))?.[1]

  const suma = attr('Suma oszacowania')
  const cena = attr('Cena wywołania')

  // Multi-lot notices (several .template-item blocks in one obwieszczenie)
  // carry one price/area per lot and no overall figure. Presenting the first
  // lot's value as the auction's Verkehrswert would be misleading — take no
  // structured price/area at all then (same idea as mv-zvgcom's
  // extractSingleVerkehrswert). The description (first lot) and the Sygnatura
  // apply to the notice as a whole and are kept.
  const multiLot = $('.template-item').length > 1

  // "Sygnatura: Km 314/18" (or "Sygnatury: Km 1022/19, KM 489/19; …") in the notice header.
  const sygMatch = $.text().match(/Sygnatur(?:a|y):\s*([A-Za-zŻżŹź]{1,5}\s?[A-Za-z]{0,4}\s?\d+\/\d+)/)
  // "przy Sądzie Rejonowym w Zgorzelcu" — the city stays in its locative form,
  // matching the conventional court name ("Sąd Rejonowy w Zgorzelcu").
  const courtMatch = $.text().match(/Sądzie\s+Rejonowym\s+w\s+([\p{Lu}][\p{Ll}]+)/u)

  return {
    beschreibung,
    aktenzeichen: sygMatch ? clean(sygMatch[1]!) : null,
    amtsgericht: courtMatch ? `Sąd Rejonowy w ${courtMatch[1]}` : null,
    sumaOszacowaniaPln: !multiLot && suma ? parsePlPrice(suma.split('(')[0]!) : null,
    cenaWywolaniaPln: !multiLot && cena ? parsePlPrice(cena.split('(')[0]!) : null,
    livingAreaSqm: !multiLot && beschreibung ? parseLivingAreaSqm(beschreibung) : null,
  }
}

/** Fetch the detail page and fill in the description, Verkehrswert (Suma
 *  oszacowania; Cena wywołania only as fallback), Wohnfläche and Sygnatura. */
export async function enrichOne(auction: Auction): Promise<void> {
  if (!auction.detailUrlUpstream) return
  const res = await fetch(auction.detailUrlUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`PL detail fetch failed: ${res.status} ${auction.detailUrlUpstream}`)
  const html = await res.text()
  await archiveDetailCapture(
    Buffer.from(html, 'utf8'),
    {
      platform: auction.platform,
      country: auction.country,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber,
      authority: auction.authority,
    } satisfies DocumentIdentity,
    auction.detailUrlUpstream,
    new Date().toISOString(),
  )
  // A WAF/error page can still answer HTTP 200 — without this check it would
  // parse into a silent, successful no-op and suppress retries.
  if (!html.includes('notice-template-wrapper')) {
    throw new Error(`PL detail fetch returned unexpected page (WAF/error?): ${auction.detailUrlUpstream}`)
  }
  const detail = parseDetailHtml(html)

  if (detail.beschreibung) auction.description = detail.beschreibung
  if (detail.aktenzeichen) auction.caseNumber = detail.aktenzeichen
  if (detail.amtsgericht) auction.authority = detail.amtsgericht
  if (detail.livingAreaSqm != null) auction.sourceLivingAreaSqm = detail.livingAreaSqm
  auction.startingBid = detail.cenaWywolaniaPln ?? null

  const pln = detail.sumaOszacowaniaPln ?? (auction.marketValue ? null : detail.cenaWywolaniaPln)
  if (pln != null) {
    auction.marketValue = pln
    auction.currency = 'PLN'
    auction.marketValueText = formatPln(pln)
  }
}
