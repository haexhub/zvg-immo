// Serves a photo extracted from an auction's Gutachten/Exposé PDF. The enrich
// task writes the cached files under .cache_zvg/images/<platform>/<id>/, and
// the /api/auctions overlay synthesizes the URL into `thumbnailUrl`.
//
// Strict parameter whitelist: only ascii-slug platform/id and `<index>.<ext>`
// filenames are accepted, so no `..` or path traversal is possible.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafePathSegment } from '../../../../utils/path-segment'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

// `<md5-prefix>.<ext>` — content-addressable filenames written by
// extractPdfPhotos. Strict allow-list keeps path traversal impossible.
const FILENAME_RE = /^([0-9a-f]{8,32})\.(jpg|jpeg|png)$/i

const CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

export default defineEventHandler(async (event) => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  const name = String(event.context.params?.name ?? '')

  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const match = FILENAME_RE.exec(name)
  if (!match || !match[2]) {
    throw createError({ statusCode: 400, statusMessage: 'invalid filename' })
  }
  const ext = match[2].toLowerCase()
  const filePath = join(IMAGES_DIR, platform, id, name)
  // Single guarded read: check-then-use would race with cache cleanup and add
  // redundant I/O. readFile itself surfaces ENOENT which we translate to 404.
  let buf: Buffer
  try {
    buf = await readFile(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createError({ statusCode: 404, statusMessage: 'not found' })
    }
    throw err
  }
  setHeader(event, 'content-type', CONTENT_TYPE[ext] ?? 'application/octet-stream')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return buf
})
