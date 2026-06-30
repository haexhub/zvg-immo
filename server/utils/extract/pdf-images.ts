// Extracts photos embedded in a Gutachten/Exposé PDF via poppler's `pdfimages`
// (already in the runtime image). Filters out junk: too-small icons, masks,
// extreme aspect ratios, and logos that repeat across pages. Results are
// written to .cache_zvg/images/<platform>/<id>/ as `0.jpg`/`0.png`/… and the
// list of filenames is returned for the extraction cache.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { fetchPdfBuffer } from './pdf-text'

const exec = promisify(execFile)

export const DEFAULT_FILTER = {
  minWidth: 400,
  minHeight: 300,
  /** Reject panoramic strips and sidebar banners. */
  maxAspectRatio: 6,
  /** Near-square smallish images (typical letterhead crests / state coats of
   *  arms) — they pass the dimension filter but are essentially never the
   *  property photos we want. Real photos shot with a camera are nearly
   *  always rectangular (4:3 or 3:2). */
  squareThreshold: 1000,
  squareAspectMin: 0.85,
  squareAspectMax: 1.15,
} as const

const DEFAULT_MAX_PHOTOS = 12

export interface PdfImageInfo {
  page: number
  num: number
  type: string
  width: number
  height: number
  color: string
  enc: string
}

/**
 * Parse `pdfimages -list -p` output (whitespace-separated columns; one header
 * line, one rule line, then one row per image).
 */
export function parseImageList(stdout: string): PdfImageInfo[] {
  const out: PdfImageInfo[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('page') || line.startsWith('---')) continue
    const cols = line.split(/\s+/)
    if (cols.length < 9) continue
    const page = Number(cols[0])
    const num = Number(cols[1])
    const width = Number(cols[3])
    const height = Number(cols[4])
    if (![page, num, width, height].every(Number.isFinite)) continue
    out.push({
      page,
      num,
      type: cols[2] ?? 'image',
      width,
      height,
      color: cols[5] ?? '',
      enc: cols[8] ?? '',
    })
  }
  return out
}

export interface ImageFilterOptions {
  minWidth?: number
  minHeight?: number
  maxAspectRatio?: number
  squareThreshold?: number
  squareAspectMin?: number
  squareAspectMax?: number
}

/**
 * Apply size and aspect-ratio filters. Masks, small/elongated rasters,
 * near-square smallish images (typical letterhead crests) and page-1 rasters
 * (typical cover pages) are almost never the property photos we want.
 */
export function filterImages(
  items: readonly PdfImageInfo[],
  opts: ImageFilterOptions = {},
): PdfImageInfo[] {
  const cfg = { ...DEFAULT_FILTER, ...opts }
  return items.filter((it) => {
    if (it.type !== 'image') return false
    // Page 1 of Gutachten/Exposé is virtually always a cover/title page; the
    // first real photo lives on page 2+. Dropping it avoids the cover image
    // landing as the auction's thumbnail.
    if (it.page <= 1) return false
    if (it.width < cfg.minWidth || it.height < cfg.minHeight) return false
    const aspect = Math.max(it.width / it.height, it.height / it.width)
    if (aspect > cfg.maxAspectRatio) return false
    const ratio = it.width / it.height
    const longestSide = Math.max(it.width, it.height)
    if (
      longestSide < cfg.squareThreshold &&
      ratio >= cfg.squareAspectMin &&
      ratio <= cfg.squareAspectMax
    ) {
      return false
    }
    return true
  })
}

/** Keep first occurrence, drop later duplicates by hash. */
export function dedupByHash<T extends { hash: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    if (seen.has(it.hash)) continue
    seen.add(it.hash)
    out.push(it)
  }
  return out
}

export interface ExtractPhotosOptions {
  destDir: string
  maxPhotos?: number
}

/**
 * Fetch the PDF at `proxyUrl`, extract embedded raster images, filter and
 * dedupe them, write the keepers to `destDir`. Returns the list of filenames
 * (e.g. `['0.jpg', '1.png']`). Returns `[]` on any failure or if no photo-sized
 * image is present.
 */
export async function extractPdfPhotos(
  proxyUrl: string,
  opts: ExtractPhotosOptions,
): Promise<string[]> {
  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) return []

  const workDir = await mkdtemp(join(tmpdir(), 'zvg-pdfimages-'))
  const inputPath = join(workDir, 'in.pdf')
  await writeFile(inputPath, buf)

  try {
    let listOut: string
    try {
      const { stdout } = await exec('pdfimages', ['-list', '-p', inputPath], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      listOut = stdout
    } catch {
      return []
    }
    const wanted = filterImages(parseImageList(listOut))
    if (wanted.length === 0) return []

    // `-j -png`: emit JPEG-encoded images as .jpg, everything else as .png.
    // This avoids browser-hostile JP2/PPM/TIFF outputs that `-all` would write.
    const prefix = join(workDir, 'img')
    try {
      await exec('pdfimages', ['-j', '-png', '-p', inputPath, prefix], {
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024,
      })
    } catch {
      return []
    }

    const files = await readdir(workDir)
    const fileByPageNum = new Map<string, string>()
    for (const f of files) {
      const m = /^img-(\d+)-(\d+)\.([a-z0-9]+)$/i.exec(f)
      if (!m) continue
      fileByPageNum.set(`${Number(m[1])}:${Number(m[2])}`, f)
    }

    // Landscape first: camera-shot property photos are almost always
    // landscape, while portrait images in Gutachten are usually data sheets,
    // floor plans, or geoport maps. This puts the most photo-like image at
    // index 0, which becomes the listing's thumbnail.
    const sorted = [...wanted].sort((a, b) => {
      const aLandscape = a.width >= a.height ? 0 : 1
      const bLandscape = b.width >= b.height ? 0 : 1
      if (aLandscape !== bLandscape) return aLandscape - bLandscape
      return a.page - b.page || a.num - b.num
    })
    const withBytes: { file: string; bytes: Buffer; hash: string }[] = []
    for (const info of sorted) {
      const file = fileByPageNum.get(`${info.page}:${info.num}`)
      if (!file) continue
      const bytes = await readFile(join(workDir, file))
      const hash = createHash('md5').update(bytes).digest('hex')
      withBytes.push({ file, bytes, hash })
    }
    const deduped = dedupByHash(withBytes).slice(0, opts.maxPhotos ?? DEFAULT_MAX_PHOTOS)
    if (deduped.length === 0) return []

    await mkdir(opts.destDir, { recursive: true })
    const written: string[] = []
    // Content-addressable filename: `<md5-prefix>.<ext>`. A unique byte stream
    // gets a unique URL, so the API can serve files with `immutable` honestly
    // — re-extracting the same image just produces the same filename.
    for (const entry of deduped) {
      const ext = (extname(entry.file).toLowerCase() || '.jpg').replace(/^\./, '')
      const name = `${entry.hash.slice(0, 16)}.${ext}`
      await writeFile(join(opts.destDir, name), entry.bytes)
      written.push(name)
    }
    return written
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
