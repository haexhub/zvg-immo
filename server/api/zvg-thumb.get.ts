// Renders the first page of a Foto.pdf attachment as a JPEG thumbnail.
// Uses poppler's pdftoppm CLI tool — no Node native deps required.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ZVG_BASE } from '../crawlers/zvg-portal/constants'
import { fetchPdfBuffer } from '../utils/extract/pdf-text'
import { renderPdfPageJpeg } from '../utils/extract/pdf-render'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'thumbs')
// Anonymous route and every new id pair is a cache miss: bound the upstream
// fetches and pdftoppm processes a caller can start at once.
// ponytail: process-local counter; a shared queue is the upgrade path if the
// app ever runs several replicas.
const MAX_CONCURRENT_RENDERS = 2
let activeRenders = 0

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const fileId = String(q.file_id ?? '')
  const zvgId = String(q.zvg_id ?? '')
  const landAbk = String(q.land_abk ?? 'sn')
  if (!/^\d+$/.test(fileId) || !/^\d+$/.test(zvgId) || !/^[a-z]{2}$/.test(landAbk)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid params' })
  }

  const cachePath = join(CACHE_DIR, `${landAbk}-${zvgId}-${fileId}.jpg`)

  let imageBuf: Buffer
  try {
    imageBuf = await readFile(cachePath)
  } catch {
    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
      throw createError({ statusCode: 503, statusMessage: 'Thumbnail-Erzeugung ist ausgelastet' })
    }
    activeRenders++
    try {
      const pdf = await fetchPdfBuffer(
        `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${landAbk}&file_id=${fileId}&zvg_id=${zvgId}`,
      )
      if (!pdf) throw new Error('PDF download failed')
      imageBuf = await renderPdfPageJpeg(pdf)
      await mkdir(CACHE_DIR, { recursive: true })
      const tmp = `${cachePath}.${randomUUID()}.tmp`
      await writeFile(tmp, imageBuf)
      await rename(tmp, cachePath)
    } catch (err) {
      // Details (upstream status, temp paths in pdftoppm errors) stay in the
      // server log; the anonymous client only learns that rendering failed.
      console.warn(`[zvg-thumb] ${landAbk}/${zvgId}/${fileId}: ${(err as Error).message}`)
      throw createError({ statusCode: 502, statusMessage: 'Thumbnail-Erzeugung fehlgeschlagen' })
    } finally {
      activeRenders--
    }
  }

  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return imageBuf
})
