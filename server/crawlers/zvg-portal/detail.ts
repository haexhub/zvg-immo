import { load } from 'cheerio'
import type { Attachment, AttachmentKind } from '~/types/auction'
import { ZVG_BASE, UA } from './constants'
import { decodeEntities, parseFileSize } from './text'

const KIND_RULES: Array<[RegExp, AttachmentKind]> = [
  [/bekanntmachung/i, 'bekanntmachung'],
  [/foto|bild|photo/i, 'foto'],
  [/expose/i, 'exposee'],
  [/gutacht|verkehrswert/i, 'gutachten'],
]

function classifyAttachment(label: string, filename: string): AttachmentKind {
  const text = `${label} ${filename}`
  for (const [re, kind] of KIND_RULES) if (re.test(text)) return kind
  return 'sonstiges'
}

export interface DetailInfo {
  attachments: Attachment[]
  beschreibung: string | null
}

export async function fetchDetailPage(zvgId: string, landAbk: string): Promise<DetailInfo> {
  const url = `${ZVG_BASE}/index.php?button=showZvg&zvg_id=${zvgId}&land_abk=${landAbk}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
      'Accept-Language': 'de-DE,de;q=0.9',
      Referer: `${ZVG_BASE}/index.php?button=Suchen`,
    },
  })
  if (!res.ok) return { attachments: [], beschreibung: null }
  const html = await res.text()
  if (html.length < 64 && html.trim() === 'error') {
    return { attachments: [], beschreibung: null }
  }

  // Each attachment row: <td>Label:</td><td><a href="?button=showAnhang...">filename.pdf</a> <img...> <span>NN.NN kB</span></td>
  // Each attachment lives in its own <tr> with two <td>s: label and link+size.
  // cheerio handles the malformed self-closing tags reliably; we walk row by row.
  const $ = load(html)
  const attachments: Attachment[] = []
  const seenFileIds = new Set<string>()
  $('tr').each((_, tr) => {
    const tds = $(tr).find('> td')
    if (tds.length < 2) return
    const anchor = $(tr).find('a[href*="showAnhang"]').first()
    if (!anchor.length) return
    const href = anchor.attr('href') || ''
    const fileIdMatch = href.match(/file_id=(\d+)/)
    const fileId = fileIdMatch?.[1]
    if (!fileId) return
    if (seenFileIds.has(fileId)) return
    seenFileIds.add(fileId)

    const labelCell = tds.eq(0)
    const linkCell = anchor.closest('td')
    const label = labelCell
      .text()
      .replace(/[: \s]+$/, '')
      .trim()
    const filename = anchor.text().trim()
    const sizeText = linkCell.find('span').text() || linkCell.text().replace(filename, '')
    attachments.push({
      kind: classifyAttachment(label, filename),
      label,
      filename,
      sizeBytes: parseFileSize(sizeText),
      fileId,
      proxyUrl: `/api/zvg-proxy?button=showAnhang&land_abk=${landAbk}&file_id=${fileId}&zvg_id=${zvgId}`,
    })
  })

  // Beschreibung is in the same column as Objekt/Lage. Extract the full block.
  let beschreibung: string | null = null
  const beschrMatch = html.match(/Beschreibung[^<]*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
  if (beschrMatch?.[1]) {
    const text = beschrMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    const cleaned = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim()
    if (cleaned.length > 0) beschreibung = cleaned
  }

  return { attachments, beschreibung }
}

export async function enrichInBatches<T extends { zvgId: string }>(
  items: T[],
  landAbk: string,
  enricher: (item: T, info: DetailInfo) => void,
  concurrency = 10,
): Promise<void> {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      if (!item || !/^\d+$/.test(item.zvgId)) continue
      try {
        const info = await fetchDetailPage(item.zvgId, landAbk)
        enricher(item, info)
      } catch {
        // Best-effort enrichment; skip on error
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}
