// Rasterizes PDF pages to JPEGs via poppler's `pdftoppm` (already in the
// runtime image). Used for two purposes that both need "a PDF page as an
// image": the pdf-thumb API (server/api/pdf-thumb.get.ts, photo-only PDF
// attachments) and the vision-LLM page images in llm-documents.ts (Gutachten
// PDFs that are scanned images, where pdftotext returns nothing useful).

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Gutachten in the bake-off ranged 1-35 pages; this bounds LLM image-token
// cost per document rather than reflecting a real-world page limit.
const DEFAULT_MAX_RENDER_PAGES = 20

// Fit every page into this pixel box instead of a fixed DPI: a fixed DPI makes
// the bitmap size follow the untrusted MediaBox (a 200-inch plan page would be
// ~18k px square). 1100 px is about what A4 gave at the former 90 DPI.
const JPEG_ARGS = ['-jpeg', '-jpegopt', 'quality=80', '-scale-to', '1100']

/** Rasterize one 1-based PDF page to a JPEG buffer. */
export async function renderPdfPageJpeg(pdfBuf: Buffer, page = 1): Promise<Buffer> {
  const dir = join(tmpdir(), `pdf-render-${randomUUID()}`)
  const inputPath = `${dir}.pdf`
  const outputPrefix = `${dir}-out`
  const outputPath = `${outputPrefix}.jpg`
  try {
    await writeFile(inputPath, pdfBuf)
    await exec(
      'pdftoppm',
      [
        ...JPEG_ARGS,
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
      [...JPEG_ARGS, '-f', '1', '-l', String(lastPage), inputPath, outputPrefix],
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
