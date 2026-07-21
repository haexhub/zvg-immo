// Rasterizes a PDF page to a JPEG via poppler's `pdftoppm` (already in the
// runtime image, see server/api/pdf-thumb.get.ts). Used for two purposes that
// both need "a PDF page as an image": the pdf-thumb API (photo-only PDF
// attachments) and the vision-LLM fallback in server/tasks/enrich.ts (Gutachten
// PDFs that are scanned images, where pdftotext returns nothing useful).

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fetchPdfBuffer } from './pdf-text'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-render')

/** Rasterize one 1-based PDF page to a JPEG buffer. */
export async function renderPdfPageJpeg(pdfBuf: Buffer, page = 1): Promise<Buffer> {
  const dir = join(tmpdir(), `pdf-render-${randomUUID()}`)
  const inputPath = `${dir}.pdf`
  const outputPrefix = `${dir}-out`
  const outputPath = `${outputPrefix}.jpg`
  await writeFile(inputPath, pdfBuf)
  try {
    await exec(
      'pdftoppm',
      [
        '-jpeg', '-jpegopt', 'quality=80',
        '-r', '90',
        '-f', String(page), '-l', String(page),
        '-singlefile',
        inputPath, outputPrefix,
      ],
      { timeout: 30_000 },
    )
    return await readFile(outputPath)
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(outputPath, { force: true }),
    ])
  }
}

/**
 * Fetch the PDF at `proxyUrl`, rasterize `page` and return it base64-encoded —
 * or null on any failure (download or rendering). Cached on disk keyed by
 * (url, page) so a capped-LLM retry across enrich runs never re-renders the
 * same page twice.
 */
export async function pdfPageToBase64Jpeg(proxyUrl: string, page = 1): Promise<string | null> {
  const key = createHash('sha1').update(`${proxyUrl}#${page}`).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.jpg`)
  try {
    return (await readFile(cachePath)).toString('base64')
  } catch {
    // miss — fetch + render below
  }

  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) return null
  try {
    const jpeg = await renderPdfPageJpeg(buf, page)
    await mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${cachePath}.${randomUUID()}.tmp`
    await writeFile(tmp, jpeg)
    await rename(tmp, cachePath)
    return jpeg.toString('base64')
  } catch {
    return null
  }
}
