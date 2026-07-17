import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { US_BASE, US_CHANNELS, US_STATE_NAMES, UA, COUNTRY } from './constants'

// Be polite: bid4assets.com does some UA/rate-based bot mitigation (a bare
// fetch without a realistic User-Agent gets a 403). Keep concurrency low and
// pace requests out instead of firing all ~30 channel requests at once.
const CHANNEL_CONCURRENCY = 2
const REQUEST_DELAY_MS = 400
const FETCH_RETRIES = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${US_BASE}${href.startsWith('/') ? '' : '/'}${href}`
}

/** Retries transient failures (timeout, network error, 5xx) so a single blip
 *  doesn't zero out a whole channel until the next crawl cycle. 4xx responses
 *  are not retried — they won't succeed on a second attempt. */
async function htmlFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`bid4assets.com ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`bid4assets.com ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {}) // drain body to avoid socket leak on retried 5xx
    }
    await sleep(500 * 2 ** attempt)
  }
}

/** Raw shape of one row of the Kendo grid's embedded data (see
 *  extractGridRows) — a subset of the fields the live page actually sends;
 *  unused fields (BidCount, CustomClosedStatusLabel, …) are omitted. */
interface RawRow {
  AuctionID: number
  Asset_Title: string | null
  ActualCloseTime: string | null
  MinimumBid: number | null
  DebtAmount: number | null
  CourtCase: string | null
  SheriffNumber: string | null
  Defendant: string | null
  Plaintiff: string | null
  Township: string | null
  Attorney: string | null
  Address: string | null
  IsPostponedOrStayed: boolean | null
  /** Never observed populated live (always `[]` across every sampled
   *  channel/listing — sheriff sales here don't ship property photos), but
   *  the grid schema declares the field, so it's parsed defensively in case
   *  some channel does populate it. Exact item shape unconfirmed; both plain
   *  string URLs and `{Url: string}`-style objects are handled. */
  Images?: unknown[] | null
}

interface ChannelDoc {
  url: string
  label: string
}

interface ChannelResult {
  rows: RawRow[]
  docs: ChannelDoc[]
}

/** The Kendo grid on each channel page is initialized with its full dataset
 *  inline (`kendoGrid({..., "data": {"Data": [...], "Total": N}})`) rather
 *  than via a separate AJAX call — confirmed by comparing the declared
 *  "Total" against the number of embedded rows across multiple channels
 *  (they always match, even for a page with 54 rows). So a single GET per
 *  channel is enough; no pagination requests are needed. The surrounding
 *  object isn't valid JSON as a whole (the sibling "type" field is a JS
 *  function call, not a JSON value), so the "data" sub-object is located by
 *  its literal marker and isolated via brace-matching before JSON.parse. */
function extractGridRows(html: string): RawRow[] {
  const marker = '"data":{"Data":['
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) throw new Error('Bid4Assets listings grid marker not found')
  const objStart = markerIdx + '"data":'.length
  let depth = 0
  let end = -1
  // String-aware: a listing field (e.g. an address) could itself contain a
  // literal '{' or '}', which would desync a naive brace counter and either
  // truncate the object early or never find its end.
  let inString = false
  let escaped = false
  for (let i = objStart; i < html.length; i++) {
    const char = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) throw new Error('Bid4Assets listings grid is incomplete')
  const parsed = JSON.parse(html.slice(objStart, end)) as { Data?: unknown }
  if (!Array.isArray(parsed.Data)) throw new Error('Bid4Assets listings grid has invalid data')
  return parsed.Data as RawRow[]
}

/** Each channel page links its general sale-conditions PDF (e.g. "Franklin
 *  County Sheriff Terms of Sale") directly on the listing/channel page
 *  itself — the same document is also shown on every individual auction's
 *  detail page, so fetching it once per channel (instead of once per
 *  listing) avoids an extra request per auction. */
function extractDocs(html: string): ChannelDoc[] {
  const $ = load(html)
  const docs: ChannelDoc[] = []
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href')
    if (!href || !/\.pdf(?:$|\?)/i.test(href)) return
    docs.push({ url: absoluteUrl(href), label: clean($(el).text()) || 'Sheriff Sale Terms' })
  })
  return docs
}

async function fetchChannel(slug: string): Promise<ChannelResult | null> {
  try {
    const html = await htmlFetch(`${US_BASE}/${slug}`)
    const rows = extractGridRows(html)
    return { rows, docs: extractDocs(html) }
  } catch (err) {
    console.error(`[us-bid4assets] failed to fetch channel "${slug}"`, err)
    return null
  }
}

/** Every sampled listing title follows "<County/Parish name>, <ST> Sheriff
 *  Sale: <address>" (e.g. "Franklin County, PA Sheriff Sale: 761 FREY ROAD",
 *  "Calcasieu Parish, LA Sheriff Sale: 4008 WEST WALTON STREET") — more
 *  reliable than the row's own `County` field, which is sometimes null. */
const TITLE_RE = /^(.+?),\s*([A-Z]{2})\s+Sheriff Sale:/

/** Some titles carry a leading status marker before the county name, e.g.
 *  "***STAYED***Adams County, PA Sheriff Sale: …" — that status is already
 *  captured separately via `row.IsPostponedOrStayed` (see `aufgehoben`), so
 *  strip it here rather than let it leak into the county name. */
function parseCountyState(title: string | null): { county: string | null; state: string | null } {
  if (!title) return { county: null, state: null }
  const m = title.replace(/^\*{2,}[^*]+\*{2,}/, '').match(TITLE_RE)
  return m ? { county: m[1] ?? null, state: m[2] ?? null } : { county: null, state: null }
}

/** "2026-09-11T15:00:00" -> ISO string kept as naive local time (matching how
 *  the other crawlers store court-published times without a UTC offset,
 *  since the actual zone varies by county/channel) plus a German-labelled
 *  display string, consistent with dk/is. */
function parseTermin(actualCloseTime: string | null): { terminIso: string | null; terminText: string | null } {
  if (!actualCloseTime) return { terminIso: null, terminText: null }
  const m = actualCloseTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return { terminIso: null, terminText: null }
  const [, y, mo, d, hh, mm] = m
  return { terminIso: `${y}-${mo}-${d}T${hh}:${mm}:00`, terminText: `${d}.${mo}.${y}, ${hh}:${mm} Uhr` }
}

function extractPhotoUrls(images: unknown[] | null | undefined): string[] {
  if (!Array.isArray(images)) return []
  return images
    .map((img) => {
      if (typeof img === 'string') return img
      if (img && typeof img === 'object') {
        const obj = img as Record<string, unknown>
        const url = obj.Url ?? obj.url ?? obj.ImageUrl
        return typeof url === 'string' ? url : null
      }
      return null
    })
    .filter((url): url is string => Boolean(url))
    .map(absoluteUrl)
}

function mapRow(row: RawRow, docs: ChannelDoc[], platformId: string): Auction {
  const zvgId = String(row.AuctionID)
  const { county, state } = parseCountyState(row.Asset_Title)
  const region = state ? (US_STATE_NAMES[state] ?? state) : ''
  const amtsgericht = county ? `${county} Sheriff` : 'Bid4Assets Sheriff Sale'
  const { terminIso, terminText } = parseTermin(row.ActualCloseTime)

  const formatUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  // Neither field is a property valuation — DebtAmount is the judgment/debt
  // balance and MinimumBid is the opening bid, not an appraised value. Unlike
  // DK/SE/HU/GB (where the source publishes an actual valuation), Bid4Assets
  // exposes no such field, so verkehrswertEur stays null rather than
  // mislabeling debt/bid as a property value; both amounts are still surfaced
  // as explicitly labeled figures in the description.
  const verkehrswertEur = null
  const verkehrswertText = null

  const beschreibung =
    [
      row.DebtAmount && row.DebtAmount > 0 ? `Debt amount: ${formatUsd(row.DebtAmount)}` : null,
      row.MinimumBid && row.MinimumBid > 1 ? `Minimum bid: ${formatUsd(row.MinimumBid)}` : null,
      row.Defendant ? `Defendant: ${row.Defendant}` : null,
      row.Plaintiff ? `Plaintiff: ${row.Plaintiff}` : null,
      row.Township ? `Township: ${row.Township}` : null,
      row.Attorney ? `Attorney: ${row.Attorney}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null

  const attachments: Attachment[] = docs.map((doc) => ({
    kind: classifyAttachment(doc.label, doc.url),
    label: doc.label,
    filename: doc.url.split('/').pop()?.split('?')[0] ?? 'terms.pdf',
    sizeBytes: null,
    fileId: doc.url,
    proxyUrl: doc.url,
  }))

  const photos = extractPhotoUrls(row.Images)
  const detailUrl = `${US_BASE}/auction/${row.AuctionID}`

  return {
    platform: platformId,
    country: COUNTRY,
    region,
    zvgId,
    // Unlike FR (which never publishes a real court reference), many US
    // judicial sheriff sales do — use it when present.
    aktenzeichen: row.CourtCase || row.SheriffNumber || '',
    amtsgericht,
    objekt: null,
    adresse: row.Address || null,
    verkehrswertEur,
    verkehrswertText,
    terminIso,
    terminText,
    aufgehoben: row.IsPostponedOrStayed === true,
    letzteAktualisierungIso: null,
    pdfUrl: attachments[0]?.proxyUrl ?? null,
    detailUrl,
    pdfUrlUpstream: attachments[0]?.proxyUrl ?? null,
    detailUrlUpstream: detailUrl,
    attachments,
    beschreibung,
    fotoCount: photos.length,
    thumbnailUrl: photos[0] ?? null,
    ...(photos.length > 0 ? { photoUrls: photos } : {}),
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const results: (ChannelResult | null)[] = new Array(US_CHANNELS.length).fill(null)

  let cursor = 0
  async function worker() {
    while (cursor < US_CHANNELS.length) {
      const i = cursor++
      await sleep(REQUEST_DELAY_MS)
      results[i] = await fetchChannel(US_CHANNELS[i]!)
    }
  }
  await Promise.all(Array.from({ length: CHANNEL_CONCURRENCY }, worker))

  const seen = new Set<string>()
  const auctions: Auction[] = []
  for (const result of results) {
    if (!result) continue
    for (const row of result.rows) {
      const zvgId = String(row.AuctionID)
      if (seen.has(zvgId)) continue
      seen.add(zvgId)
      auctions.push(mapRow(row, result.docs, platformId))
    }
  }

  return { auctions, total: auctions.length }
}
