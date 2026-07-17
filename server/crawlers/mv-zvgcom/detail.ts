import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { ZVGCOM_BASE, UA, AUFGEHOBEN_PLACEHOLDER_IMG } from './constants'
import { extractSingleVerkehrswert, stripDivHtml } from './text'

interface PdfResponse {
  result: number
  pdf?: string
  expose?: string
  /** Gallery-page link — empty on every live listing checked; the actual
   *  photo list comes from act=getGalleryPics instead. */
  bilder?: string
  /** Court-specific Biethinweise PDF (e.g. /biethinweise/tipgreves.pdf). */
  hinweis?: string
}

interface GalleryResponse {
  result: number
  data?: string[]
}

async function fetchText(id: string, act: string): Promise<string> {
  const res = await fetch(`${ZVGCOM_BASE}/v2024/termine.prg?act=${act}&id=${id}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`zvg.com ${act}: HTTP ${res.status}`)
  return res.text()
}

async function fetchPdfLinks(id: string): Promise<PdfResponse> {
  const res = await fetch(`${ZVGCOM_BASE}/v2024/termine.prg?act=getPDF&id=${id}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`zvg.com getPDF: HTTP ${res.status}`)
  return res.json() as Promise<PdfResponse>
}

/** Full photo gallery (site paths like /bilder/rostock/68k30-25.jpg) — the
 *  same endpoint the zvg.com frontend's Bildergalerie uses. */
async function fetchGalleryPics(id: string): Promise<string[]> {
  const res = await fetch(`${ZVGCOM_BASE}/v2024/termine.prg?act=getGalleryPics&id=${id}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`zvg.com getGalleryPics: HTTP ${res.status}`)
  const json = (await res.json()) as GalleryResponse
  return (json.data ?? []).filter((p) => p && p !== AUFGEHOBEN_PLACEHOLDER_IMG)
}

/** Fetches the free-text Beschreibung and the two lot-specific documents the
 *  listing endpoint doesn't expose: the official Aktenzeichen-based
 *  Bekanntmachung and (when present) a short Exposé. The Gutachten (if any)
 *  is already attached at list time — see list.ts. */
export async function enrichOne(auction: Auction): Promise<void> {
  const [html, links, galleryPics] = await Promise.all([
    fetchText(auction.zvgId, 'getText'),
    fetchPdfLinks(auction.zvgId),
    fetchGalleryPics(auction.zvgId).catch(() => []),
  ])

  const text = stripDivHtml(html)
  if (text) auction.beschreibung = text

  // The grid reports vwert=0 for some auctions although the free text names
  // the value — pull it from there, but never override a structured value.
  if (auction.verkehrswertEur == null && text) {
    const vw = extractSingleVerkehrswert(text)
    if (vw) {
      auction.verkehrswertEur = vw.eur
      auction.verkehrswertText = vw.text
    }
  }

  if (galleryPics.length > 0) {
    auction.photoUrls = galleryPics.map((p) => (p.startsWith('http') ? p : `${ZVGCOM_BASE}${p}`))
    auction.fotoCount = auction.photoUrls.length
  }

  const extra: Attachment[] = []
  if (links.pdf) {
    const filename = links.pdf.split('/').pop() || 'Bekanntmachung.pdf'
    extra.push({
      kind: classifyAttachment('Bekanntmachung', filename),
      label: 'Bekanntmachung',
      filename,
      sizeBytes: null,
      fileId: links.pdf,
      proxyUrl: links.pdf,
    })
  }
  if (links.expose) {
    const filename = links.expose.split('/').pop() || 'Kurzbeschreibung.pdf'
    extra.push({
      kind: classifyAttachment('Kurzbeschreibung Exposé', filename),
      label: 'Kurzbeschreibung',
      filename,
      sizeBytes: null,
      fileId: links.expose,
      proxyUrl: links.expose,
    })
  }
  if (links.hinweis) {
    const filename = links.hinweis.split('/').pop() || 'Biethinweise.pdf'
    extra.push({
      kind: 'sonstiges',
      label: 'Biethinweise',
      filename,
      sizeBytes: null,
      fileId: links.hinweis,
      proxyUrl: links.hinweis,
    })
  }
  const seenFileIds = new Set(auction.attachments.map((a) => a.fileId))
  for (const a of extra) if (!seenFileIds.has(a.fileId)) auction.attachments.push(a)
}
