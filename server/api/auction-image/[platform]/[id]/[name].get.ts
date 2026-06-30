// Serves a photo extracted from an auction's Gutachten/Exposé PDF. The enrich
// task writes the cached files under .cache_zvg/images/<platform>/<id>/, and
// the /api/auctions overlay synthesizes the URL into `thumbnailUrl`.
//
// Strict parameter whitelist: only ascii-slug platform/id and `<index>.<ext>`
// filenames are accepted, so no `..` or path traversal is possible.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
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

  if (!SLUG_RE.test(platform) || !SLUG_RE.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const match = FILENAME_RE.exec(name)
  if (!match || !match[2]) {
    throw createError({ statusCode: 400, statusMessage: 'invalid filename' })
  }
  const ext = match[2].toLowerCase()
  const filePath = join(IMAGES_DIR, platform, id, name)
  try {
    await stat(filePath)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }
  const buf = await readFile(filePath)
  setHeader(event, 'content-type', CONTENT_TYPE[ext] ?? 'application/octet-stream')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return buf
})
