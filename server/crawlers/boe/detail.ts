import type { Auction } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { BOE_BASE } from './constants'
import { boeFetch, looksLikeCaptcha, markBoeCaptcha } from './fetch'
import { clean, parseEuroEs } from './text'

/**
 * Subset of fields we extract from /detalleSubasta.php.
 * Fields stay nullable because not every auction populates every row.
 */
export interface DetailInfo {
  /** From ver=1 "Tasación" — the appraised market value, mapped to marketValueEur. */
  tasacionEur: number | null
  tasacionText: string | null
  /** From ver=1 "Valor subasta" — minimum acceptable bid amount. */
  valorSubastaText: string | null
  /** From ver=1 "Anuncio BOE" — BOE-B-yyyy-... id. */
  anuncioBoeId: string | null
  /** Long descripción from ver=3. Falls back to null. */
  description: string | null
  /** From ver=3 "Referencia catastral" — the cadastral parcel reference. */
  referenciaCatastral: string | null
  /** Best-effort formatted street address from ver=3 columns. */
  address: string | null
}

async function fetchTab(idSub: string, ver: 1 | 3): Promise<string> {
  const url = `${BOE_BASE}/detalleSubasta.php?idSub=${encodeURIComponent(idSub)}&ver=${ver}`
  const html = await boeFetch(url)
  if (looksLikeCaptcha(html)) {
    console.warn(
      `[boe] CAPTCHA on detail ${idSub} ver=${ver} at ${new Date().toISOString()} — arming 24h cooldown`,
    )
    await markBoeCaptcha()
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
    const k = clean((m[1] ?? '').replace(/<[^>]+>/g, ''))
    const v = clean((m[2] ?? '').replace(/<[^>]+>/g, ' '))
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

function parseVer3(html: string): Pick<DetailInfo, 'description' | 'referenciaCatastral' | 'address'> {
  const p = extractTablePairs(html)
  const description = p.get('descripción') ?? p.get('descripcion') ?? null
  // Skip "no consta" placeholders per-field BEFORE composing — otherwise a
  // valid CP would be dropped together with a "no consta" localidad.
  const drop = (s: string | null | undefined): string | null =>
    s && !/no consta/i.test(s) ? s : null
  const referenciaCatastral = drop(p.get('referencia catastral'))
  const street = drop(p.get('dirección') ?? p.get('direccion'))
  const cp = drop(p.get('código postal') ?? p.get('codigo postal'))
  const localidad = drop(p.get('localidad'))
  const provincia = drop(p.get('provincia'))
  const cpLocalidad = [cp, localidad].filter(Boolean).join(' ').trim() || null
  const parts = [street, cpLocalidad, provincia, 'España'].filter(
    (s): s is string => Boolean(s),
  )
  const address = parts.length >= 2 ? parts.join(', ') : null
  return { description, referenciaCatastral, address }
}

/** Fetches both relevant detail tabs for one subasta and merges them. */
export async function fetchDetail(auction: Auction): Promise<DetailInfo> {
  const identity: DocumentIdentity = {
    platform: auction.platform,
    country: auction.country,
    region: auction.region,
    externalId: auction.externalId,
    caseNumber: auction.caseNumber,
    authority: auction.authority,
  }
  const capturedAt = new Date().toISOString()
  // Promise.all is safe here — the shared rate gate in fetch.ts serializes
  // both requests internally, so the 800ms gap still applies between them.
  const [v1, v3] = await Promise.all([
    fetchTab(auction.externalId, 1),
    fetchTab(auction.externalId, 3),
  ])
  // BOE never attaches a PDF/DOCX (auction.attachments stays empty, see
  // list.ts) — this HTML is the only record of tasación/descripción/
  // dirección/referencia catastral, so it's the G1 archive target here.
  // Both tabs are archived as one capture: recordCapture dedups on
  // (kind, platform, externalId), so archiving them separately would make
  // the two distinct docs ping-pong and mint a capture row every run.
  const url = `${BOE_BASE}/detalleSubasta.php?idSub=${encodeURIComponent(auction.externalId)}`
  const combined = Buffer.from(`${v1}\n<!-- boe:ver=3 -->\n${v3}`, 'utf8')
  await archiveDetailCapture(combined, identity, url, capturedAt)
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
      const info = await fetchDetail(auction)
      apply(auction, info)
      enriched++
    } catch (err) {
      // Swallowed on purpose — partial enrichment is better than aborting
      // the whole batch — but emit at debug level so the rare BOE captcha
      // / 5xx is visible when investigating.
      console.debug(`[boe] detail enrichment failed for ${auction.externalId}: ${(err as Error).message}`)
      errors++
    }
  }
  return { enriched, errors }
}
