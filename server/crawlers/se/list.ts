import type { Auction } from '~/types/auction'
import { getRates, toEur } from '~/server/utils/exchange-rate'
import { SE_BASE, COUNTRY } from './constants'
import { extractFact, parseSekAmount, extractBody } from './text'

const DETAIL_CONCURRENCY = 4
const LIST_URL = `${SE_BASE}/Sokfastigheterbostadsratter.html?query=*`

async function htmlFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'sv,en;q=0.9',
      'User-Agent': 'zvg-immo/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`kronofogden.se ${url}: HTTP ${res.status}`)
  return res.text()
}

function extractListingIds(html: string): string[] {
  const raw = html.match(/href="\/(\d+)\.html"/g) ?? []
  return [...new Set(raw.map((m) => m.match(/\/(\d+)\.html/)![1]!))]
}

function mapDetail(
  id: string,
  html: string,
  platformId: string,
  rates: Record<string, number>,
): Auction {
  const adresse = extractFact(html, 'Adress')
  const kommun = extractFact(html, 'Kommun')
  const marknadsvardRaw = extractFact(html, 'Marknadsvarde')
  const arendenummer = extractFact(html, 'Arendenummer') ?? ''
  const storlek = extractFact(html, 'Storlek')

  // Auction date: <div id="datumet" ...>2026-08-27</div>
  const datumM = html.match(/<div id="datumet"[^>]*>(\d{4}-\d{2}-\d{2})<\/div>/)
  const terminIso = datumM?.[1] ?? null

  // First downloadable PDF attached to the listing
  const pdfM = html.match(/href="(\/download\/[^"]+\.pdf)"/)
  const pdfUrl = pdfM?.[1] ? `${SE_BASE}${pdfM[1]}` : null

  // First listing image (srcset, smallest variant) for thumbnail
  const thumbM = html.match(/srcset="(\/images\/[^\s]+)\s+160w/)
  const thumbnailUrl = thumbM?.[1] ? `${SE_BASE}${thumbM[1]}` : null

  // Count all distinct image references
  const imgMatches = html.match(/srcset="\/images\/[^\s]+\s+160w/g) ?? []
  const fotoCount = new Set(imgMatches).size

  // Build full address: "Kvarnbyn 76, Burträsk, Skellefteå kommun"
  const adresseParts = [adresse, kommun].filter(Boolean)
  const fullAddress = adresseParts.length > 0 ? adresseParts.join(', ') : null

  // Convert SEK to EUR via ECB rate
  const sekAmount = marknadsvardRaw ? parseSekAmount(marknadsvardRaw) : null
  const verkehrswertEur = sekAmount != null ? toEur(sekAmount, 'SEK', rates) : null

  // Build description: prepend Storlek so area pipeline can extract living area
  const body = extractBody(html)
  const beschreibung = [storlek ? `Storlek: ${storlek}` : null, body]
    .filter(Boolean)
    .join('\n') || null

  return {
    platform: platformId,
    country: COUNTRY,
    region: 'all',
    zvgId: id,
    aktenzeichen: arendenummer,
    amtsgericht: 'Kronofogden',
    objekt: null,
    adresse: fullAddress,
    verkehrswertEur,
    verkehrswertText: marknadsvardRaw ? `${marknadsvardRaw} SEK` : null,
    terminIso,
    terminText: terminIso,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl,
    detailUrl: `${SE_BASE}/${id}.html`,
    pdfUrlUpstream: pdfUrl,
    detailUrlUpstream: `${SE_BASE}/${id}.html`,
    attachments: [],
    beschreibung,
    fotoCount,
    thumbnailUrl,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const [rates, listHtml] = await Promise.all([getRates(), htmlFetch(LIST_URL)])
  const ids = extractListingIds(listHtml)
  if (ids.length === 0) return { auctions: [], total: 0 }

  // Fetch detail pages with bounded concurrency
  const htmls: (string | null)[] = new Array(ids.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++
      const id = ids[i]
      if (!id) continue
      try {
        htmls[i] = await htmlFetch(`${SE_BASE}/${id}.html`)
      } catch {
        htmls[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = ids
    .map((id, i) => (htmls[i] ? mapDetail(id, htmls[i]!, platformId, rates) : null))
    .filter((a): a is Auction => a !== null)

  return { auctions, total: auctions.length }
}
