// Renders the first page of a PDF attachment as a JPEG. Used by LotPopover to
// show PDF-only foto attachments (AT-Edikte "Foto" sections wrap each photo
// in a PDF, zvg-portal Foto.pdf) as image slides in the swiper — <img src="…pdf">
// silently fails in the browser.
//
// Cache on disk keyed by the sha1 of the source URL. fetchPdfBuffer handles
// both `/api/zvg-proxy?…` (routes to upstream with the required Referer) and
// direct AT-Edikte / biddit URLs; the ALLOWED_HOSTS list is a defensive
// allowlist against arbitrary SSRF via ?src=.

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fetchPdfBuffer } from '../utils/extract/pdf-text'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-thumbs')

const ALLOWED_HOSTS = new Set([
  'edikte.justiz.gv.at',
  'www.biddit.be',
  'biddit.be',
])

function isAllowedSource(src: string): boolean {
  if (src.startsWith('/api/zvg-proxy?')) return true
  try {
    const u = new URL(src)
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

async function renderFirstPage(pdfBuf: Buffer): Promise<Buffer> {
  const base = join(tmpdir(), `pdf-thumb-${randomUUID()}`)
  const inputPath = `${base}.pdf`
  const outputPrefix = `${base}-out`
  const outputPath = `${outputPrefix}.jpg`
  await writeFile(inputPath, pdfBuf)
  try {
    await exec(
      'pdftoppm',
      [
        '-jpeg', '-jpegopt', 'quality=80',
        '-r', '90',
        '-f', '1', '-l', '1',
        '-singlefile',
        inputPath, outputPrefix,
      ],
      { timeout: 30_000 },
    )
    return await readFile(outputPath)
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => {}),
      unlink(outputPath).catch(() => {}),
    ])
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
    const pdf = await fetchPdfBuffer(src)
    if (!pdf) {
      throw createError({ statusCode: 502, statusMessage: 'PDF-Download fehlgeschlagen' })
    }
    try {
      buf = await renderFirstPage(pdf)
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
  }

  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return buf
})
