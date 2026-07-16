import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { ZVGCOM_BASE, UA } from './constants'
import { stripDivHtml } from './text'

interface PdfResponse {
  result: number
  pdf?: string
  expose?: string
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

/** Fetches the free-text Beschreibung and the two lot-specific documents the
 *  listing endpoint doesn't expose: the official Aktenzeichen-based
 *  Bekanntmachung and (when present) a short Exposé. The Gutachten (if any)
 *  is already attached at list time — see list.ts. */
export async function enrichOne(auction: Auction): Promise<void> {
  const [html, links] = await Promise.all([
    fetchText(auction.zvgId, 'getText'),
    fetchPdfLinks(auction.zvgId),
  ])

  const text = stripDivHtml(html)
  if (text) auction.beschreibung = text

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
  const seenFileIds = new Set(auction.attachments.map((a) => a.fileId))
  for (const a of extra) if (!seenFileIds.has(a.fileId)) auction.attachments.push(a)
}
