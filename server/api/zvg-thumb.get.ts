// Renders the first page of a Foto.pdf attachment as a JPEG thumbnail.
// Uses poppler's pdftoppm CLI tool — no Node native deps required.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'
const ZVG_BASE = 'https://www.zvg-portal.de'
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'thumbs')

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function fetchPdf(landAbk: string, fileId: string, zvgId: string): Promise<Buffer> {
  const url = `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${landAbk}&file_id=${fileId}&zvg_id=${zvgId}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/pdf,*/*',
      Referer: `${ZVG_BASE}/index.php?button=Suchen`,
    },
  })
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 64 && buf.toString('utf8').trim() === 'error') {
    throw new Error('upstream rejected request')
  }
  if (!buf.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
    throw new Error('not a PDF')
  }
  return buf
}

async function renderThumbnail(pdfBuf: Buffer, fileId: string): Promise<Buffer> {
  const inputPath = join(tmpdir(), `zvg-${fileId}-${process.pid}.pdf`)
  const outputPrefix = join(tmpdir(), `zvg-${fileId}-${process.pid}-out`)
  await writeFile(inputPath, pdfBuf)
  try {
    await exec('pdftoppm', [
      '-jpeg', '-jpegopt', 'quality=80',
      '-r', '90',
      '-f', '1', '-l', '1',
      '-singlefile',
      inputPath, outputPrefix,
    ], { timeout: 20_000 })
    return await readFile(`${outputPrefix}.jpg`)
  } finally {
    // Best-effort cleanup
    await Promise.all([
      readFile(inputPath).then(() => exec('rm', ['-f', inputPath])).catch(() => {}),
      readFile(`${outputPrefix}.jpg`).then(() => exec('rm', ['-f', `${outputPrefix}.jpg`])).catch(() => {}),
    ])
  }
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const fileId = String(q.file_id ?? '')
  const zvgId = String(q.zvg_id ?? '')
  const landAbk = String(q.land_abk ?? 'sn')
  if (!/^\d+$/.test(fileId) || !/^\d+$/.test(zvgId) || !/^[a-z]{2}$/.test(landAbk)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid params' })
  }

  await ensureCacheDir()
  const cachePath = join(CACHE_DIR, `${landAbk}-${zvgId}-${fileId}.jpg`)

  let imageBuf: Buffer
  if (await fileExists(cachePath)) {
    imageBuf = await readFile(cachePath)
  } else {
    try {
      const pdf = await fetchPdf(landAbk, fileId, zvgId)
      imageBuf = await renderThumbnail(pdf, fileId)
      await writeFile(cachePath, imageBuf)
    } catch (err) {
      throw createError({
        statusCode: 502,
        statusMessage: 'Thumbnail-Erzeugung fehlgeschlagen',
        data: { detail: (err as Error).message },
      })
    }
  }

  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'public, max-age=86400, immutable')
  return imageBuf
})
