// Downloads native photo URLs (AT-Edikte JPGs, Biddit JPEGs, zvbawü thumbs, …)
// into `.cache_zvg/images/<platform>/<id>/`. Mirrors extractPdfPhotos' output
// contract so the /api/auctions overlay can synthesise a /api/auction-image
// URL regardless of which pipeline produced the file. Not for PDF-embedded
// images — that's what extractPdfPhotos is for.

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dispatcher } from 'undici'
import { detectImageExt, imageContentHash } from './image-bytes'

// Network/timeout errors are left to throw (unlike a non-OK HTTP status,
// which resolves to null below): downloadNativeImages needs to tell "fetch
// never even completed" apart from "server responded, no image here" so it
// can avoid reporting a transient network failure as a confirmed absence of
// photos (see photosCheckedAt/photoFailures in enrich.ts).
async function fetchImageBytes(url: string, opts: Pick<DownloadNativeImagesOptions, 'dispatcher' | 'redirect'>): Promise<Buffer | null> {
  const res = await fetch(url, {
    // 30s upper bound: the enrich task's Promise.all fan-out would otherwise
    // stall a whole worker on one hung upstream. AT-Edikte (Lotus-Domino) is
    // the slowest we hit, ~500ms typical.
    signal: AbortSignal.timeout(30_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0',
      Accept: 'image/jpeg,image/png,image/*;q=0.9,*/*;q=0.1',
    },
    redirect: opts.redirect,
    dispatcher: opts.dispatcher,
  } as RequestInit & { dispatcher?: Dispatcher })
  if (!res.ok) {
    // Transient — worth a retry, unlike a stable 404/403 on a dead link.
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new Error(`image fetch failed with HTTP ${res.status}`)
    }
    return null
  }
  return Buffer.from(await res.arrayBuffer())
}

const DEFAULT_MAX_IMAGES = 12
const MIN_BYTES = 512

export interface DownloadNativeImagesOptions {
  destDir: string
  maxImages?: number
  dispatcher?: Dispatcher
  redirect?: RequestRedirect
}

/**
 * Fetch each URL, verify it's a real JPEG/PNG, write to `destDir` under a
 * content-addressable `<md5-16>.<ext>` name. Returns the filenames in the
 * order given (deduped by hash). Re-running against the same URLs is safe
 * for the files on disk (same hash → no rewrite), but every URL is still
 * fetched: the hash is derived from the downloaded bytes, so it isn't known
 * before the fetch. Callers who want to avoid re-downloads must skip the
 * call themselves (see the enrich task's cached-photos reuse).
 */
export async function downloadNativeImages(
  urls: readonly string[],
  opts: DownloadNativeImagesOptions,
): Promise<string[]> {
  if (urls.length === 0) return []
  const cap = opts.maxImages ?? DEFAULT_MAX_IMAGES
  await mkdir(opts.destDir, { recursive: true })

  // Existing files: <hash>.<ext>. The hash comes from the downloaded bytes,
  // so this set can only skip the re-write of a file we already have — the
  // fetch itself has already happened by the time we know the hash. Bulk
  // read once per call.
  const existing = new Set<string>()
  try {
    for (const name of await readdir(opts.destDir)) {
      const m = /^([0-9a-f]{16})\.(jpg|png|webp)$/.exec(name)
      if (m?.[1]) existing.add(m[1])
    }
  } catch {
    // dir just created above; readdir shouldn't fail. If it does, treat as empty.
  }

  const written: string[] = []
  const seenHashes = new Set<string>()
  let hadFetchError = false
  // The cap counts successful downloads, not attempts — dead URLs at the
  // front of the list must not block valid ones further back.
  for (const url of urls) {
    if (written.length >= cap) break
    let buf: Buffer | null
    try {
      buf = await fetchImageBytes(url, opts)
    } catch {
      hadFetchError = true
      continue
    }
    if (!buf || buf.length < MIN_BYTES) continue
    const ext = detectImageExt(buf)
    if (!ext) continue

    const hash = imageContentHash(buf)
    if (seenHashes.has(hash)) continue
    seenHashes.add(hash)
    const name = `${hash}.${ext}`
    if (!existing.has(hash)) {
      await writeFile(join(opts.destDir, name), buf)
      existing.add(hash)
    }
    written.push(name)
  }
  // Nothing came back *and* at least one URL failed at the network level:
  // can't tell this apart from "all dead links", but it's exactly the
  // transient-failure shape the caller needs to retry rather than treat as a
  // confirmed empty gallery. If some URLs did succeed, a few dead ones among
  // them are unremarkable and not worth failing the whole listing over.
  if (written.length === 0 && hadFetchError) {
    throw new Error('all native image fetches failed (network error)')
  }
  return written
}
