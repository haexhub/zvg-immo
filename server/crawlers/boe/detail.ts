import type { Auction } from '~/types/auction'
import { BOE_BASE } from './constants'
import { boeFetch, looksLikeCaptcha } from './fetch'
import { clean, parseEuroEs } from './text'

/**
 * Subset of fields we extract from /detalleSubasta.php.
 * Fields stay nullable because not every auction populates every row.
 */
export interface DetailInfo {
  /** From ver=1 "Tasación" — the appraised market value, mapped to verkehrswertEur. */
  tasacionEur: number | null
  tasacionText: string | null
  /** From ver=1 "Valor subasta" — minimum acceptable bid amount. */
  valorSubastaText: string | null
  /** From ver=1 "Anuncio BOE" — BOE-B-yyyy-... id. */
  anuncioBoeId: string | null
  /** Long descripción from ver=3. Falls back to null. */
  beschreibung: string | null
  /** Best-effort formatted street address from ver=3 columns. */
  adresse: string | null
}

async function fetchTab(idSub: string, ver: 1 | 3): Promise<string> {
  const url = `${BOE_BASE}/detalleSubasta.php?idSub=${encodeURIComponent(idSub)}&ver=${ver}`
  const html = await boeFetch(url)
  if (looksLikeCaptcha(html)) {
    throw new Error(`BOE CAPTCHA on ${idSub} ver=${ver}`)
  }
  return html
}

/** Pulls `<th>Label</th><td>Value</td>` rows out of a BOE detail table.
 *  The labels are the only stable handle since attribute classes change
 *  between AT/JA/NE subastas. */
function extractTablePairs(html: string): Map<string, string> {
  const pairs = new Map<string, string>()
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g
  for (const m of html.matchAll(re)) {
    const k = clean(m[1].replace(/<[^>]+>/g, ''))
    const v = clean(m[2].replace(/<[^>]+>/g, ' '))
    if (k) pairs.set(k.toLowerCase(), v)
  }
  return pairs
}

function parseVer1(html: string): Pick<DetailInfo, 'tasacionEur' | 'tasacionText' | 'valorSubastaText' | 'anuncioBoeId'> {
  const p = extractTablePairs(html)
  const tasacion = p.get('tasación') ?? p.get('tasacion') ?? null
  return {
    tasacionEur: tasacion ? parseEuroEs(tasacion) : null,
    tasacionText: tasacion,
    valorSubastaText: p.get('valor subasta') ?? null,
    anuncioBoeId: p.get('anuncio boe') ?? null,
  }
}

function parseVer3(html: string): Pick<DetailInfo, 'beschreibung' | 'adresse'> {
  const p = extractTablePairs(html)
  const beschreibung = p.get('descripción') ?? p.get('descripcion') ?? null
  const street = p.get('dirección') ?? p.get('direccion') ?? null
  const cp = p.get('código postal') ?? p.get('codigo postal') ?? null
  const localidad = p.get('localidad') ?? null
  const provincia = p.get('provincia') ?? null
  // Compose a Nominatim-friendly line. Skip parts that say "no consta" /
  // are clearly placeholders.
  const parts = [street, [cp, localidad].filter(Boolean).join(' '), provincia, 'España'].filter(
    (s): s is string => Boolean(s) && !/no consta/i.test(s),
  )
  const adresse = parts.length >= 2 ? parts.join(', ') : null
  return { beschreibung, adresse }
}

/** Fetches both relevant detail tabs for one subasta and merges them. */
export async function fetchDetail(idSub: string): Promise<DetailInfo> {
  // Promise.all is safe here — the shared rate gate in fetch.ts serializes
  // both requests internally, so the 800ms gap still applies between them.
  const [v1, v3] = await Promise.all([fetchTab(idSub, 1), fetchTab(idSub, 3)])
  return { ...parseVer1(v1), ...parseVer3(v3) }
}

/**
 * Sequentially enriches the auctions in place. Per-auction errors are
 * swallowed — partial enrichment is better than none if BOE rate-limits a
 * handful of requests mid-batch.
 */
export async function enrichInBatches(
  auctions: Auction[],
  apply: (auction: Auction, info: DetailInfo) => void,
): Promise<{ enriched: number; errors: number }> {
  let enriched = 0
  let errors = 0
  for (const auction of auctions) {
    try {
      const info = await fetchDetail(auction.zvgId)
      apply(auction, info)
      enriched++
    } catch (err) {
      // Swallowed on purpose — partial enrichment is better than aborting
      // the whole batch — but emit at debug level so the rare BOE captcha
      // / 5xx is visible when investigating.
      console.debug(`[boe] detail enrichment failed for ${auction.zvgId}: ${(err as Error).message}`)
      errors++
    }
  }
  return { enriched, errors }
}
