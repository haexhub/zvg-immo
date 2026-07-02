// Downloads native photo URLs (AT-Edikte JPGs, Biddit JPEGs, zvbawü thumbs, …)
// into `.cache_zvg/images/<platform>/<id>/`. Mirrors extractPdfPhotos' output
// contract so the /api/auctions overlay can synthesise a /api/auction-image
// URL regardless of which pipeline produced the file. Not for PDF-embedded
// images — that's what extractPdfPhotos is for.

import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** JPEG/PNG magic bytes. Guards against upstreams that return HTML/JSON error
 *  pages with a 200 status — the file would be served as an image by the API
 *  and break silently in the browser. */
function detectImageExt(buf: Buffer): 'jpg' | 'png' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }
  return null
}

async function fetchImageBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      // 30s upper bound: the enrich task's Promise.all fan-out would otherwise
      // stall a whole worker on one hung upstream. AT-Edikte (Lotus-Domino) is
      // the slowest we hit, ~500ms typical.
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0',
        Accept: 'image/jpeg,image/png,image/*;q=0.9,*/*;q=0.1',
      },
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

const DEFAULT_MAX_IMAGES = 12
const MIN_BYTES = 512

export interface DownloadNativeImagesOptions {
  destDir: string
  maxImages?: number
}

/**
 * Fetch each URL, verify it's a real JPEG/PNG, write to `destDir` under a
 * content-addressable `<md5-16>.<ext>` name. Returns the filenames in the
 * order given (deduped by hash). Existing files with the same hash are
 * reused without re-downloading — safe to re-run against the same URLs.
 */
export async function downloadNativeImages(
  urls: readonly string[],
  opts: DownloadNativeImagesOptions,
): Promise<string[]> {
  if (urls.length === 0) return []
  const cap = opts.maxImages ?? DEFAULT_MAX_IMAGES
  await mkdir(opts.destDir, { recursive: true })

  // Existing files: <hash>.<ext>. Their basenames-without-extension ARE the
  // hash prefixes, so a hash-hit can short-circuit the fetch entirely. Bulk
  // read once per call.
  const existing = new Set<string>()
  try {
    for (const name of await readdir(opts.destDir)) {
      const m = /^([0-9a-f]{16})\.(jpg|png)$/.exec(name)
      if (m?.[1]) existing.add(m[1])
    }
  } catch {
    // dir just created above; readdir shouldn't fail. If it does, treat as empty.
  }

  const written: string[] = []
  const seenHashes = new Set<string>()
  for (const url of urls.slice(0, cap)) {
    const buf = await fetchImageBytes(url)
    if (!buf || buf.length < MIN_BYTES) continue
    const ext = detectImageExt(buf)
    if (!ext) continue

    const hash = createHash('md5').update(buf).digest('hex').slice(0, 16)
    if (seenHashes.has(hash)) continue
    seenHashes.add(hash)
    const name = `${hash}.${ext}`
    if (!existing.has(hash)) {
      await writeFile(join(opts.destDir, name), buf)
      existing.add(hash)
    }
    written.push(name)
  }
  return written
}
