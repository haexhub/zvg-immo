import { load } from 'cheerio'
import type { Attachment } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { ZVG_BASE, UA } from './constants'
import { decodeEntities, isZvgErrorBody, parseFileSize } from './text'
import { describeFetchError, retryTransient, TransientUpstreamError } from '../transient-retry'
import { classifyAttachment } from '~/server/utils/classify-attachment'

export interface DetailInfo {
  attachments: Attachment[]
  description: string | null
}

const FETCH_TIMEOUT_MS = 20_000

export async function fetchDetailPage(
  zvgId: string,
  landAbk: string,
  identity?: DocumentIdentity,
): Promise<DetailInfo> {
  const url = `${ZVG_BASE}/index.php?button=showZvg&zvg_id=${zvgId}&land_abk=${landAbk}`
  let html: string
  try {
    html = await retryTransient(async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': UA,
          Accept: 'text/html',
          'Accept-Language': 'de-DE,de;q=0.9',
          Referer: `${ZVG_BASE}/index.php?button=Suchen`,
        },
      })
      if (res.status >= 500) throw new TransientUpstreamError(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.text()
      // The portal answers a bare 'error' under load or for a dropped session.
      // Throw (after the retries) so the enrich task retries later — returning
      // an empty detail would be stamped as fetched and permanently replace
      // the stored attachments.
      if (isZvgErrorBody(body)) throw new TransientUpstreamError('returned error page')
      return body
    })
  } catch (err) {
    throw new Error(`ZVG detail ${zvgId}: ${describeFetchError(err)}`, { cause: err })
  }

  // Gutachten-PDF is not present on every auction — HTML is archived
  // unconditionally rather than only as a fallback for lots without one.
  // Archiving is crawl-only: the identity is supplied by enrichInBatches;
  // callers without one get no writes.
  if (identity) {
    await archiveDetailCapture(Buffer.from(html, 'utf8'), identity, url, new Date().toISOString())
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
      proxyUrl: new URL(href, `${ZVG_BASE}/index.php`).toString(),
    })
  })

  // Beschreibung is in the same column as Objekt/Lage. Extract the full block.
  let description: string | null = null
  const beschrMatch = html.match(/Beschreibung[^<]*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
  if (beschrMatch?.[1]) {
    const text = beschrMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    const cleaned = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim()
    if (cleaned.length > 0) description = cleaned
  }

  return { attachments, description }
}

export async function enrichInBatches<T extends DocumentIdentity>(
  items: T[],
  landAbk: string,
  enricher: (item: T, info: DetailInfo) => void,
  concurrency = 10,
): Promise<{ enriched: number; errors: number; firstError?: unknown }> {
  let cursor = 0
  let enriched = 0
  let errors = 0
  let firstError: unknown
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      if (!item || !/^\d+$/.test(item.externalId)) continue
      try {
        const info = await fetchDetailPage(item.externalId, landAbk, item)
        enricher(item, info)
        enriched++
      } catch (err) {
        console.debug(
          `[zvg-portal] detail enrichment failed for ${item.externalId}: ${(err as Error).message}`,
        )
        errors++
        firstError ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors, firstError }
}
