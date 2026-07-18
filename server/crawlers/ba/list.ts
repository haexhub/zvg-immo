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
    marketValueEur: price?.eur ?? null,
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

export async function fetchAllListings(platformId: string): Promise<{ auctions: Auction[]; total: number | null }> {
  const firstPage = await apiFetch<ListItem[]>(
    `/sudske-prodaje?page=1&pageSize=${PAGE_SIZE}&vrstaPredmeta=${VRSTA}`,
  )
  if (firstPage.length === 0) return { auctions: [], total: 0 }

  const total = firstPage[0]!.total
  const pageCount = Math.ceil(total / PAGE_SIZE)

  // Fetch remaining pages (parallel, tolerant of individual failures)
  const remaining = await Promise.allSettled(
    Array.from({ length: pageCount - 1 }, (_, i) =>
      apiFetch<ListItem[]>(
        `/sudske-prodaje?page=${i + 2}&pageSize=${PAGE_SIZE}&vrstaPredmeta=${VRSTA}`,
      ),
    ),
  )
  const allItems: ListItem[] = [
    ...firstPage,
    ...remaining.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
  ]

  // Fetch detail for each item with bounded concurrency
  const details: (DetailResponse | null)[] = new Array(allItems.length).fill(null)
  let cursor = 0
  async function detailWorker() {
    while (cursor < allItems.length) {
      const i = cursor++
      const item = allItems[i]
      if (!item) continue
      try {
        details[i] = await apiFetch<DetailResponse>(`/vijest/${item.id}?lang=B`)
      } catch {
        details[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, () => detailWorker()))

  const auctions = allItems.map((item, i) => mapItem(item, details[i] ?? null, platformId))
  return { auctions, total }
}
