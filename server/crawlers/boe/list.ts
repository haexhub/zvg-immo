import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { BOE_BASE, COUNTRY, ES_REGION_NAMES } from './constants'
import { clean, parseSpanishDateTime } from './text'

export interface ParseResult {
  totalReported: number | null
  auctions: Auction[]
}

/**
 * Builds a GET-style search URL for one provincia. Only the filters we
 * actually need are included — empty `campo[]/dato[]` pairs trigger the
 * "Se ha producido un error en la búsqueda" page on POST submits.
 *
 * The estado filter is required: dropping it makes BOE return an empty
 * result set even though the same query with `estado=EJ` returns dozens of
 * active auctions. EJ ("ejecutándose") covers all currently-running
 * auctions, which is the analogue of the active ZVG appointments.
 */
export function buildSearchUrl(provincia: string): string {
  const params = new URLSearchParams()
  params.append('campo[2]', 'SUBASTA.ESTADO.CODIGO')
  params.append('dato[2]', 'EJ')
  params.append('campo[3]', 'BIEN.TIPO')
  params.append('dato[3]', 'I')
  params.append('campo[8]', 'BIEN.COD_PROVINCIA')
  params.append('dato[8]', provincia)
  // 500 hits/page is the largest the form allows in the dropdown.
  params.append('page_hits', '500')
  params.append('sort_field[0]', 'SUBASTA.FECHA_FIN')
  params.append('sort_order[0]', 'desc')
  params.append('accion', 'Buscar')
  return `${BOE_BASE}/subastas_ava.php?${params.toString()}`
}

/**
 * Parses one BOE search-result page. Each `<li class="resultado-busqueda">`
 * carries the listing summary; we extract the id, gestora (authority),
 * estado, conclusion date and the description+address blob. Verkehrswert
 * (tasación) is not in the listing and stays null until detail enrichment.
 */
export function parseListingHtml(
  html: string,
  provincia: string,
  platformId: string,
): ParseResult {
  const $ = load(html)
  const auctions: Auction[] = []
  const provinciaName = ES_REGION_NAMES[provincia] || provincia

  // "Resultados 1 a 77 de 77" — pull the total if present.
  const totalMatch = html.match(/Resultados[\s\S]{0,80}?de\s+(\d+)/i)
  const totalReported = totalMatch?.[1] ? parseInt(totalMatch[1], 10) : null

  $('li.resultado-busqueda').each((_i, el) => {
    const $el = $(el)
    const idMatch = $el.find('h3').first().text().match(/SUB-[A-Z]+-\d{4}-[A-Z0-9]+/)
    if (!idMatch) return
    const idSub = idMatch[0]

    const gestora = clean($el.find('h4').first().text())

    // First <p>: "Estado: Celebrándose - [Conclusión prevista: 25/05/2026 a las 18:00:00]"
    // Second <p>: description with embedded address.
    const ps = $el.find('> p')
    const estadoLine = clean(ps.eq(0).text())
    const descLine = clean(ps.eq(1).text())

    // Extract estado code (e.g. "Celebrándose" → EJ). The HTML doesn't carry
    // the code directly, so we match on the localised label.
    const aufgehoben = /(?:cancelada|suspendida|finalizada)/i.test(estadoLine)

    // "Conclusión prevista: 25/05/2026 a las 18:00:00"
    const terminMatch = estadoLine.match(/Conclusión[^:]*:\s*([^\]]+)/i)
    const terminText = terminMatch?.[1]?.trim() ?? null
    const terminIso = terminText ? parseSpanishDateTime(terminText) : null

    // Estado prefix before the bracket: "Estado: Celebrándose" → "Celebrándose"
    const estadoMatch = estadoLine.match(/Estado:\s*([^\-\[]+)/i)
    const estadoLabel = estadoMatch?.[1]?.trim() ?? null

    // Description and address are merged in the listing. Take the whole
    // string as `objekt` for now and let detail enrichment split it later.
    const objekt = descLine || null

    // Best-effort address: trailing fragment that starts with a 5-digit CP.
    let adresse: string | null = null
    if (descLine) {
      const cp = descLine.match(/(\d{5}\s+[^,]+?)(?:\s*\(|$)/)
      if (cp?.[1]) adresse = `${cp[1].trim()}, España`
    }

    const detailUrlUpstream = `${BOE_BASE}/detalleSubasta.php?idSub=${encodeURIComponent(idSub)}`

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: provinciaName,
      zvgId: idSub,
      aktenzeichen: idSub,
      amtsgericht: gestora || estadoLabel || '',
      objekt,
      adresse,
      verkehrswertEur: null,
      verkehrswertText: null,
      terminIso,
      terminText,
      aufgehoben,
      letzteAktualisierungIso: null,
      pdfUrl: null,
      detailUrl: detailUrlUpstream, // BOE detail pages need no special Referer.
      pdfUrlUpstream: null,
      detailUrlUpstream,
      attachments: [],
      beschreibung: null,
      fotoCount: 0,
      thumbnailUrl: null,
    })
  })

  // Deduplicate by id (defensive — listings sometimes repeat lots).
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.zvgId)) return false
    seen.add(a.zvgId)
    return true
  })

  return { totalReported, auctions: unique }
}

