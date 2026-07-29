// Renders the first page of a PDF attachment as a JPEG. Used by LotPopover to
// show PDF-only foto attachments (AT-Edikte "Foto" sections wrap each photo
// in a PDF, zvg-portal Foto.pdf) as image slides in the swiper — <img src="…pdf">
// silently fails in the browser.
//
// Cache on disk keyed by the sha1 of the original document URL.
// fetchPdfBuffer supplies the source-specific Referer server-side; the
// ALLOWED_HOSTS list is a defensive allowlist against arbitrary SSRF via ?src=.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchPdfBuffer } from '../utils/extract/pdf-text'
import { renderPdfPageJpeg } from '../utils/extract/pdf-render'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-thumbs')
const MAX_CONCURRENT_RENDERS = 2
let activeRenders = 0

const ALLOWED_HOSTS = new Set([
  'edikte.justiz.gv.at',
  'www.biddit.be',
  'biddit.be',
  'www.zvg-portal.de',
])

function isAllowedSource(src: string): boolean {
  try {
    const u = new URL(src)
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const src = String(q.src ?? '')
  if (!src || !isAllowedSource(src)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid src' })
  }

  const key = createHash('sha1').update(src).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.jpg`)

  let buf: Buffer
  try {
    buf = await readFile(cachePath)
  } catch {
    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
      throw createError({ statusCode: 503, statusMessage: 'PDF-Vorschau ist ausgelastet' })
    }
    activeRenders++
    try {
      const pdf = await fetchPdfBuffer(src)
      if (!pdf) {
        throw createError({ statusCode: 502, statusMessage: 'PDF-Download fehlgeschlagen' })
      }
      try {
        buf = await renderPdfPageJpeg(pdf)
      } catch (err) {
        throw createError({
          statusCode: 502,
          statusMessage: 'Rendering fehlgeschlagen',
          data: { detail: (err as Error).message },
        })
      }
      await mkdir(CACHE_DIR, { recursive: true })
      const tmp = `${cachePath}.${randomUUID()}.tmp`
      await writeFile(tmp, buf)
      await rename(tmp, cachePath)
    } finally {
      activeRenders--
    }
  }

  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return buf
})
