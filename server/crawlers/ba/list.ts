import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { BA_API_BASE, BA_WEB_BASE, COUNTRY, entityCode } from './constants'
import { parseBaDate, parseBamPrice, extractLocation, stripHtml } from './text'

// Real estate only (vrstaPredmeta=1 = Nekretnine)
const VRSTA = 1
const PAGE_SIZE = 50
const DETAIL_CONCURRENCY = 8

interface ListItem {
  id: number
  naslov: string
  datumProdaje: string
  insId: number
  institucija: string
  total: number
}

interface DetailDoc {
  id: number
  tipDoc: string
  naziv?: string | null
  nazivFajla?: string | null
  opis?: string | null
}

interface DetailResponse {
  id: number
  naslov: string
  datumProdaje?: string
  sadrzaj: string
  dokumenti?: DetailDoc[]
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BA_API_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'zvg-immo/1.0' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`pravosudje.ba ${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function mapItem(item: ListItem, detail: DetailResponse | null, platformId: string): Auction {
  // Strip "Zaključak o prodaji nekretnina " / "Zaključak o prodaji " prefix to get case number
  const caseNumber = (detail?.naslov ?? item.naslov)
    .replace(/^Zaklju[cč]ak\s+o\s+prodaji(?:\s+nekretnin[ae])?\s*/i, '')
    .trim() || String(item.id)

  const bodyText = detail?.sadrzaj ? stripHtml(detail.sadrzaj) : null
  const price = bodyText ? parseBamPrice(bodyText) : null
  const address = bodyText ? extractLocation(bodyText) : null

  const attachments: Attachment[] = (detail?.dokumenti ?? []).map((d) => {
    const label = d.naziv || d.nazivFajla || `Dokument ${d.id}`
    let kind = classifyAttachment(d.naziv, d.nazivFajla, d.opis)
    // The Zaključak o prodaji / oglas IS the auction announcement
    if (kind === 'other' && /zaklju[cč]|oglas/i.test(label)) kind = 'announcement'
    return {
      kind,
      label,
      filename: d.nazivFajla || label,
      sizeBytes: null,
      fileId: String(d.id),
      proxyUrl: `${BA_API_BASE}/vijest/download/${d.id}`,
    }
  })
  // Documents are often named by bare case number ("46 0 I 120389 25 I") — if
  // nothing was recognized as the announcement, the first unclassified
  // non-notice document is it. Documents classifyAttachment DID recognize
  // (gutachten, foto, …) keep their kind.
  if (!attachments.some((a) => a.kind === 'announcement')) {
    const main = attachments.find((a) => a.kind === 'other' && !/obavje|odgod/i.test(a.label))
    if (main) main.kind = 'announcement'
  }

  const pdfDoc = detail?.dokumenti?.find((d) => d.tipDoc === 'PDF') ?? null
  const pdfUrlUpstream = pdfDoc ? `${BA_API_BASE}/vijest/download/${pdfDoc.id}` : null

  const terminRaw = detail?.datumProdaje ?? item.datumProdaje
  const entity = entityCode(item.insId)
  const detailUrlUpstream = `${BA_WEB_BASE}/vstvfo/${entity}/${item.insId}/article/${item.id}`

  return {
    platform: platformId,
    country: COUNTRY,
    region: '',
    externalId: String(item.id),
    caseNumber,
    authority: item.institucija,
    title: 'Nekretnina',
    address,
    marketValueEur: null,
    marketValue: price?.bam ?? null,
    currency: price ? 'BAM' : null,
    marketValueText: price?.text ?? null,
    auctionDateIso: parseBaDate(terminRaw),
    auctionDateText: terminRaw || null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: pdfUrlUpstream,
    detailUrl: detailUrlUpstream,
    pdfUrlUpstream,
    detailUrlUpstream,
    attachments,
    description: bodyText,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

/** Runs `fn(0..count-1)` with at most `concurrency` calls in flight. */
async function runBounded(count: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<void> {
  let cursor = 0
  async function worker() {
    while (cursor < count) await fn(cursor++)
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null; complete: boolean }> {
  const firstPage = await apiFetch<ListItem[]>(
    `/sudske-prodaje?page=1&pageSize=${PAGE_SIZE}&vrstaPredmeta=${VRSTA}`,
  )
  if (!Array.isArray(firstPage)) throw new Error('pravosudje.ba: unexpected list response shape')
  if (firstPage.length === 0) return { auctions: [], total: 0, complete: true }

  // The page count derives from `total`; a missing/garbled value would make
  // Array.from({ length: NaN }) silently fetch page 1 only.
  const total = firstPage[0]!.total
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`pravosudje.ba: invalid total ${JSON.stringify(total)}`)
  }
  const pageCount = Math.ceil(total / PAGE_SIZE)

  // Remaining pages share the detail fetches' concurrency cap instead of all
  // firing at once against the court portal. A failed page is tolerated but
  // marks the run incomplete, so its listings don't read as gone.
  const pages: ListItem[][] = []
  let failedPages = 0
  await runBounded(Math.max(pageCount - 1, 0), DETAIL_CONCURRENCY, async (i) => {
    try {
      const page = await apiFetch<ListItem[]>(
        `/sudske-prodaje?page=${i + 2}&pageSize=${PAGE_SIZE}&vrstaPredmeta=${VRSTA}`,
      )
      if (!Array.isArray(page)) throw new Error('unexpected list response shape')
      pages[i] = page
    } catch (err) {
      failedPages++
      console.warn(`[pravosudje.ba] page ${i + 2} failed: ${(err as Error).message}`)
    }
  })
  const allItems: ListItem[] = [...firstPage, ...pages.flat()]

  // Fetch detail for each item with bounded concurrency
  const details: (DetailResponse | null)[] = new Array(allItems.length).fill(null)
  await runBounded(allItems.length, DETAIL_CONCURRENCY, async (i) => {
    const item = allItems[i]
    if (!item) return
    try {
      details[i] = await apiFetch<DetailResponse>(`/vijest/${item.id}?lang=B`)
    } catch {
      details[i] = null
    }
  })

  const auctions = allItems.map((item, i) => mapItem(item, details[i] ?? null, platformId))
  return { auctions, total, complete: failedPages === 0 }
}
