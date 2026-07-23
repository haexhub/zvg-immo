// Rasterizes a PDF page to a JPEG via poppler's `pdftoppm` (already in the
// runtime image, see server/api/pdf-thumb.get.ts). Used for two purposes that
// both need "a PDF page as an image": the pdf-thumb API (photo-only PDF
// attachments) and the vision-LLM fallback in server/tasks/enrich.ts (Gutachten
// PDFs that are scanned images, where pdftotext returns nothing useful).

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fetchPdfBuffer } from './pdf-text'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-render')

// Gutachten in the bake-off ranged 1-35 pages; this bounds LLM image-token
// cost per document rather than reflecting a real-world page limit.
const DEFAULT_MAX_RENDER_PAGES = 20

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

/**
 * Rasterize pages `1..min(pageCount, maxPages)` of a PDF to JPEG buffers, one
 * `pdftoppm` call for the whole range instead of one process per page. Page 1
 * of a Gutachten is almost always a cover/title page — the facts that matter
 * (defects, encumbrances, Grundbuch excerpts) are on later pages, so a
 * single-page vision fallback misses them; this is why the fallback renders a
 * range, not just page 1.
 */
export async function renderPdfPagesJpeg(
  pdfBuf: Buffer,
  opts: { maxPages?: number } = {},
): Promise<Buffer[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_RENDER_PAGES
  const workDir = await mkdtemp(join(tmpdir(), 'pdf-render-'))
  const inputPath = join(workDir, 'in.pdf')
  const outputPrefix = join(workDir, 'page')
  try {
    await writeFile(inputPath, pdfBuf)
    let totalPages = 1
    try {
      const { stdout } = await exec('pdfinfo', [inputPath], { timeout: 15_000 })
      const m = /^Pages:\s*(\d+)/m.exec(stdout)
      if (m) totalPages = Number(m[1])
    } catch {
      // pdfinfo failing (e.g. a malformed/recovered PDF) still lets
      // pdftoppm below attempt page 1.
    }
    const lastPage = Math.max(1, Math.min(totalPages, maxPages))
    await exec(
      'pdftoppm',
      ['-jpeg', '-jpegopt', 'quality=80', '-r', '90', '-f', '1', '-l', String(lastPage), inputPath, outputPrefix],
      { timeout: 60_000 },
    )
    const files = (await readdir(workDir))
      .filter((f) => f.startsWith('page-') && f.endsWith('.jpg'))
      .sort((a, b) => Number(/-(\d+)\.jpg$/.exec(a)![1]) - Number(/-(\d+)\.jpg$/.exec(b)![1]))
    return await Promise.all(files.map((f) => readFile(join(workDir, f))))
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Fetch the PDF at `proxyUrl`, rasterize pages `1..maxPages` and return them
 * base64-encoded (one entry per page) — or null on any failure. Cached on
 * disk keyed by (url, maxPages) so a capped-LLM retry across enrich runs
 * never re-renders the same pages twice.
 */
export async function pdfPagesToBase64Jpeg(
  proxyUrl: string,
  opts: { maxPages?: number } = {},
): Promise<string[] | null> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_RENDER_PAGES
  const key = createHash('sha1').update(`${proxyUrl}#pages:${maxPages}`).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.json`)
  try {
    return JSON.parse((await readFile(cachePath)).toString('utf8')) as string[]
  } catch {
    // miss — fetch + render below
  }

  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) return null
  try {
    const pages = await renderPdfPagesJpeg(buf, { maxPages })
    const encoded = pages.map((p) => p.toString('base64'))
    await mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${cachePath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(encoded))
    await rename(tmp, cachePath)
    return encoded
  } catch {
    return null
  }
}
