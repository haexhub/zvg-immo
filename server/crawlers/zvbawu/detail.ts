import type { Auction, Attachment } from '~/types/auction'
import { ZVBAWU_BASE, UA } from './constants'
import { extractInertiaPage, stripHtml } from './text'

interface DetailImage {
  id: number
  thumbnail: string
  url: string
  caption?: string
}

interface DetailPage {
  props: {
    auction: {
      id: number
      title: string
      address: string | null
      auctionDate: string | null
      price: string | null
      fileNumber: string | null
      summary: string | null
      description: string | null
      bulletin: string | null
      latlng: [number, number] | null
      firstImage: DetailImage | null
      images: DetailImage[]
      cancelled: boolean
    }
  }
}

export interface DetailInfo {
  beschreibung: string | null
  attachments: Attachment[]
  fotoCount: number
  thumbnailUrl: string | null
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  latlng: [number, number] | null
  aufgehoben: boolean
  aktenzeichen: string | null
}

const FETCH_TIMEOUT_MS = 15_000

async function fetchDetail(link: string): Promise<DetailPage | null> {
  const url = `${ZVBAWU_BASE}${link.startsWith('/') ? link : `/${link}`}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9',
      },
    })
    if (!res.ok) return null
    return extractInertiaPage<DetailPage>(await res.text())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildAttachments(d: DetailPage['props']['auction']): Attachment[] {
  const out: Attachment[] = []
  if (d.bulletin) {
    const filename = d.bulletin.split('/').pop() || 'bekanntmachung.pdf'
    out.push({
      kind: 'bekanntmachung',
      label: 'Terminsbekanntmachung',
      filename,
      sizeBytes: null,
      // Synthesize a stable id from the auction id — zvbawü doesn't expose one
      // for the PDF, and the kind+label tuple already uniquely identifies it.
      fileId: `bulletin-${d.id}`,
      proxyUrl: d.bulletin,
    })
  }
  for (const img of d.images || []) {
    out.push({
      kind: 'foto',
      label: img.caption || `Foto ${img.id}`,
      filename: img.url.split('/').pop() || `${img.id}.jpg`,
      sizeBytes: null,
      fileId: String(img.id),
      proxyUrl: img.url,
    })
  }
  return out
}

export async function fetchDetailFor(link: string): Promise<DetailInfo | null> {
  const page = await fetchDetail(link)
  if (!page) return null
  const a = page.props.auction
  const beschreibung = stripHtml([a.summary, a.description].filter(Boolean).join('\n\n')) || null
  return {
    beschreibung,
    attachments: buildAttachments(a),
    fotoCount: (a.images || []).length || (a.firstImage ? 1 : 0),
    thumbnailUrl: a.firstImage?.thumbnail ?? null,
    pdfUrl: a.bulletin || null,
    pdfUrlUpstream: a.bulletin || null,
    latlng: a.latlng ?? null,
    aufgehoben: Boolean(a.cancelled),
    aktenzeichen: a.fileNumber || null,
  }
}

export async function enrichInBatches(
  items: Auction[],
  onEnriched: (item: Auction, info: DetailInfo) => void,
  concurrency = 8,
): Promise<{ enriched: number; errors: number }> {
  let cursor = 0
  let enriched = 0
  let errors = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      if (!item) continue
      // Cancelled auctions consistently return HTTP 410 from the detail
      // endpoint. We already know they're aufgehoben from the list view, so
      // skipping spares 11 wasted requests and keeps the error count
      // meaningful — it then reflects only unexpected failures.
      if (item.aufgehoben) continue
      if (!item.detailUrlUpstream) continue
      try {
        const info = await fetchDetailFor(item.detailUrlUpstream.replace(ZVBAWU_BASE, ''))
        if (info) {
          onEnriched(item, info)
          enriched++
        } else {
          // Null = fetch failed or upstream returned non-OK / unparsable HTML.
          // Surface as an error so the aggregate count reflects reality.
          errors++
        }
      } catch {
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors }
}
