// Extracts useful gallery images embedded in a Gutachten/Exposé PDF via
// poppler's `pdfimages`: property photos, floor plans, site plans and maps.
// Fragmented image tiles are recomposed from `pdftohtml` layout coordinates and
// `pdftoppm` crops, so maps/plans stay visible as complete images instead of
// broken snippets. Filters out junk: too-small icons, masks, extreme aspect
// ratios, and logos that repeat across pages. Results are written to
// .cache_zvg/images/<platform>/<id>/ as content-addressed image files and the
// list of filenames is returned for the extraction cache.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { maxOf, minOf } from '~/lib/array-math'
import { fetchPdfBuffer } from './pdf-text'
import { imageContentHash } from './image-bytes'

const exec = promisify(execFile)

// A malformed PDF can make poppler's CLI tools repeat one stderr line per
// corrupt object (seen: a single file producing >1MB of "Unknown compression
// method in flate stream" lines) — execFile's rejection captures that stderr
// verbatim into err.message, which would otherwise ride along unbounded into
// task_run_errors / the /settings status overview on every enrich failure.
const MAX_EXEC_ERROR_MESSAGE_LENGTH = 1000

export function execErrorMessage(err: unknown): string {
  const message = (err as Error).message
  return message.length > MAX_EXEC_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_EXEC_ERROR_MESSAGE_LENGTH)}… (${message.length} chars total, truncated)`
    : message
}

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

const PDF_LAYOUT_ZOOM = 1.5
const PDF_LAYOUT_RENDER_DPI = String(Math.round(72 * PDF_LAYOUT_ZOOM))
const CLUSTER_CROP_PADDING = 2
const FRAGMENTED_CLUSTER = {
  minImages: 3,
  minWidth: 300,
  minHeight: 250,
  maxGap: 3,
} as const

export interface PdfImageInfo {
  page: number
  num: number
  type: string
  width: number
  height: number
  color: string
  enc: string
}

export interface PdfImagePlacement {
  page: number
  num: number | null
  left: number
  top: number
  width: number
  height: number
}

export interface PdfImagePageLayout {
  page: number
  width: number
  height: number
  images: PdfImagePlacement[]
}

export interface PdfImageCluster {
  page: number
  num: number
  left: number
  top: number
  width: number
  height: number
  imageKeys: string[]
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

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(/\b([a-zA-Z_][\w:-]*)="([^"]*)"/g)) {
    attrs[match[1]!] = match[2]!
  }
  return attrs
}

function finiteNumber(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse `pdftohtml -xml` image placements. Poppler's XML uses page-local
 * coordinates at the configured zoom; with `-zoom 1.5` those coordinates map
 * to `pdftoppm -r 108` crop pixels.
 */
export function parseImageLayoutXml(xml: string, imageList: readonly PdfImageInfo[] = []): PdfImagePageLayout[] {
  const imageNumsByPage = new Map<number, number[]>()
  for (const info of imageList) {
    if (info.type !== 'image') continue
    const nums = imageNumsByPage.get(info.page) ?? []
    nums.push(info.num)
    imageNumsByPage.set(info.page, nums)
  }

  const pages: PdfImagePageLayout[] = []
  for (const pageMatch of xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)) {
    const attrs = parseXmlAttrs(pageMatch[1]!)
    const page = finiteNumber(attrs.number)
    const width = finiteNumber(attrs.width)
    const height = finiteNumber(attrs.height)
    if (page == null || width == null || height == null) continue

    const nums = imageNumsByPage.get(page) ?? []
    const images: PdfImagePlacement[] = []
    let imageIndex = 0
    for (const imageMatch of pageMatch[2]!.matchAll(/<image\b([^>]*)\/>/g)) {
      const imageAttrs = parseXmlAttrs(imageMatch[1]!)
      const left = finiteNumber(imageAttrs.left)
      const top = finiteNumber(imageAttrs.top)
      const imageWidth = finiteNumber(imageAttrs.width)
      const imageHeight = finiteNumber(imageAttrs.height)
      if (left == null || top == null || imageWidth == null || imageHeight == null) continue
      images.push({
        page,
        num: nums[imageIndex] ?? null,
        left,
        top,
        width: imageWidth,
        height: imageHeight,
      })
      imageIndex += 1
    }
    pages.push({ page, width, height, images })
  }
  return pages
}

function imageKey(page: number, num: number): string {
  return `${page}:${num}`
}

function touches(a: PdfImagePlacement, b: PdfImagePlacement, maxGap: number): boolean {
  const aRight = a.left + a.width
  const bRight = b.left + b.width
  const aBottom = a.top + a.height
  const bBottom = b.top + b.height
  return (
    a.left <= bRight + maxGap &&
    b.left <= aRight + maxGap &&
    a.top <= bBottom + maxGap &&
    b.top <= aBottom + maxGap
  )
}

/**
 * Detect visually contiguous image tiles. Some PDFs, especially Microsoft
 * Print-to-PDF appraisal documents, store one displayed map, plan or photo as
 * multiple adjacent raster XObjects; extracting those objects directly produces
 * broken gallery images. A cluster is only emitted when it contains at least
 * one image that the normal gallery-image filter would otherwise keep.
 */
export function findFragmentedImageClusters(
  pages: readonly PdfImagePageLayout[],
  wantedKeys: ReadonlySet<string>,
): PdfImageCluster[] {
  const clusters: PdfImageCluster[] = []
  for (const page of pages) {
    if (page.page <= 1 || page.images.length < FRAGMENTED_CLUSTER.minImages) continue

    const seen = new Set<number>()
    for (let i = 0; i < page.images.length; i += 1) {
      if (seen.has(i)) continue
      const group: PdfImagePlacement[] = []
      const queue = [i]
      seen.add(i)
      while (queue.length > 0) {
        const idx = queue.shift()!
        const current = page.images[idx]!
        group.push(current)
        for (let j = 0; j < page.images.length; j += 1) {
          if (seen.has(j)) continue
          if (!touches(current, page.images[j]!, FRAGMENTED_CLUSTER.maxGap)) continue
          seen.add(j)
          queue.push(j)
        }
      }

      if (group.length < FRAGMENTED_CLUSTER.minImages) continue
      const nums = group
        .map((img) => img.num)
        .filter((num): num is number => num != null)
        .sort((a, b) => a - b)
      const keys = nums.map((num) => imageKey(page.page, num))
      if (!keys.some((key) => wantedKeys.has(key))) continue

      const left = Math.max(0, minOf(group.map((img) => img.left)) - CLUSTER_CROP_PADDING)
      const top = Math.max(0, minOf(group.map((img) => img.top)) - CLUSTER_CROP_PADDING)
      const right = Math.min(page.width, maxOf(group.map((img) => img.left + img.width)) + CLUSTER_CROP_PADDING)
      const bottom = Math.min(page.height, maxOf(group.map((img) => img.top + img.height)) + CLUSTER_CROP_PADDING)
      const width = right - left
      const height = bottom - top
      if (width < FRAGMENTED_CLUSTER.minWidth || height < FRAGMENTED_CLUSTER.minHeight) continue
      if (nums.length === 0) continue
      clusters.push({
        page: page.page,
        num: minOf(nums),
        left,
        top,
        width,
        height,
        imageKeys: keys,
      })
    }
  }
  return clusters
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

async function readImageLayout(
  inputPath: string,
  workDir: string,
  imageList: readonly PdfImageInfo[],
): Promise<PdfImagePageLayout[]> {
  const outputPrefix = join(workDir, 'layout')
  try {
    await exec('pdftohtml', ['-xml', '-hidden', '-noroundcoord', '-zoom', String(PDF_LAYOUT_ZOOM), inputPath, outputPrefix], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return parseImageLayoutXml(await readFile(`${outputPrefix}.xml`, 'utf8'), imageList)
  } catch {
    return []
  }
}

async function renderImageCluster(
  inputPath: string,
  workDir: string,
  cluster: PdfImageCluster,
  idx: number,
): Promise<Buffer> {
  const outputPrefix = join(workDir, `cluster-${cluster.page}-${cluster.num}-${idx}`)
  const outputPath = `${outputPrefix}.jpg`
  try {
    await exec(
      'pdftoppm',
      [
        '-jpeg', '-jpegopt', 'quality=85',
        '-r', PDF_LAYOUT_RENDER_DPI,
        '-f', String(cluster.page), '-l', String(cluster.page),
        '-singlefile',
        '-x', String(Math.floor(cluster.left)),
        '-y', String(Math.floor(cluster.top)),
        '-W', String(Math.ceil(cluster.width)),
        '-H', String(Math.ceil(cluster.height)),
        inputPath, outputPrefix,
      ],
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
    )
    return await readFile(outputPath)
  } catch (err) {
    throw new Error(`PDF image cluster render failed: ${execErrorMessage(err)}`)
  }
}

/**
 * Fetch the PDF at `proxyUrl`, extract embedded raster images, filter and
 * dedupe them, write the keepers to `destDir`. Returns the list of filenames
 * (e.g. `['0.jpg', '1.png']`). Returns `[]` only for a confirmed-empty PDF
 * (fetched fine, no photo-sized image inside). Throws instead of swallowing
 * to `[]` when the fetch or the pdfimages run itself failed — that's a
 * transient problem (network hang, timeout), not evidence the listing has no
 * photos, and the caller (enrich.ts) relies on the distinction to decide
 * between photosCheckedAt (confirmed empty) and photoFailures (retry).
 */
export async function extractPdfPhotos(
  proxyUrl: string,
  opts: ExtractPhotosOptions,
): Promise<string[]> {
  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) throw new Error(`failed to fetch PDF for photo extraction: ${proxyUrl}`)

  const workDir = await mkdtemp(join(tmpdir(), 'zvg-pdfimages-'))
  const inputPath = join(workDir, 'in.pdf')

  try {
    await writeFile(inputPath, buf)
    let listOut: string
    try {
      const { stdout } = await exec('pdfimages', ['-list', '-p', inputPath], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      listOut = stdout
    } catch (err) {
      throw new Error(`pdfimages -list failed: ${execErrorMessage(err)}`)
    }
    const imageList = parseImageList(listOut)
    const wanted = filterImages(imageList)
    if (wanted.length === 0) return []

    const wantedKeys = new Set(wanted.map((info) => imageKey(info.page, info.num)))
    const clusters = findFragmentedImageClusters(await readImageLayout(inputPath, workDir, imageList), wantedKeys)
    const clusteredKeys = new Set(clusters.flatMap((cluster) => cluster.imageKeys))
    const individualWanted = wanted.filter((info) => !clusteredKeys.has(imageKey(info.page, info.num)))

    // `-j -png`: emit JPEG-encoded images as .jpg, everything else as .png.
    // This avoids browser-hostile JP2/PPM/TIFF outputs that `-all` would write.
    const prefix = join(workDir, 'img')
    if (individualWanted.length > 0) {
      try {
        await exec('pdfimages', ['-j', '-png', '-p', inputPath, prefix], {
          timeout: 120_000,
          maxBuffer: 50 * 1024 * 1024,
        })
      } catch (err) {
        throw new Error(`pdfimages extraction failed: ${execErrorMessage(err)}`)
      }
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
    const sorted = [
      ...clusters.map((cluster) => ({
        kind: 'cluster' as const,
        cluster,
        page: cluster.page,
        num: cluster.num,
        width: cluster.width,
        height: cluster.height,
      })),
      ...individualWanted.map((info) => ({
        kind: 'image' as const,
        info,
        page: info.page,
        num: info.num,
        width: info.width,
        height: info.height,
      })),
    ].sort((a, b) => {
      const aLandscape = a.width >= a.height ? 0 : 1
      const bLandscape = b.width >= b.height ? 0 : 1
      if (aLandscape !== bLandscape) return aLandscape - bLandscape
      return a.page - b.page || a.num - b.num
    })
    const withBytes: { file: string; bytes: Buffer; hash: string }[] = []
    let clusterIndex = 0
    for (const entry of sorted) {
      if (entry.kind === 'cluster') {
        const bytes = await renderImageCluster(inputPath, workDir, entry.cluster, clusterIndex)
        clusterIndex += 1
        const hash = imageContentHash(bytes)
        withBytes.push({ file: `cluster-${entry.cluster.page}-${entry.cluster.num}.jpg`, bytes, hash })
      } else {
        const info = entry.info
        const file = fileByPageNum.get(`${info.page}:${info.num}`)
        if (!file) continue
        const bytes = await readFile(join(workDir, file))
        const hash = imageContentHash(bytes)
        withBytes.push({ file, bytes, hash })
      }
    }
    const deduped = dedupByHash(withBytes).slice(0, opts.maxPhotos ?? Number.POSITIVE_INFINITY)
    if (deduped.length === 0) return []

    await mkdir(opts.destDir, { recursive: true })
    const written: string[] = []
    // Content-addressable filename: `<hash-prefix>.<ext>`. A unique byte stream
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
