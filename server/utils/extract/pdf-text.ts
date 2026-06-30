// Fetches an attachment PDF and extracts its text with poppler's `pdftotext`
// (already in the runtime image, used by /api/zvg-thumb). Results are cached on
// disk keyed by the attachment URL so a re-processed auction never re-downloads.
//
// Attachment URLs differ by platform: zvg-portal stores a relative
// `/api/zvg-proxy?…` path (the upstream needs a specific Referer), while AT,
// zvbawü and Biddit store absolute, directly-fetchable URLs. resolveSource
// handles both.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Attachment } from '~/types/auction'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdftext')

/** Attachment kinds whose PDF most likely carries the size/type facts, best first. */
const PDF_KIND_PRIORITY = ['gutachten', 'exposee', 'bekanntmachung', 'sonstiges'] as const

/** Pick the attachment whose PDF is most likely to describe the property. */
export function pickBestPdf(attachments: Attachment[]): Attachment | null {
  for (const kind of PDF_KIND_PRIORITY) {
    const hit = attachments.find((a) => a.kind === kind)
    if (hit) return hit
  }
  return null
}

function resolveSource(proxyUrl: string): { url: string; headers: Record<string, string> } {
  if (proxyUrl.startsWith('/api/zvg-proxy')) {
    const q = new URLSearchParams(proxyUrl.split('?')[1] ?? '')
    const url = `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${q.get('land_abk')}&file_id=${q.get('file_id')}&zvg_id=${q.get('zvg_id')}`
    return { url, headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: `${ZVG_BASE}/index.php?button=Suchen` } }
  }
  return { url: proxyUrl, headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' } }
}

/**
 * Fetch the PDF at `proxyUrl` and return its bytes, or null on any failure
 * (network error, non-200, non-PDF response).
 */
export async function fetchPdfBuffer(proxyUrl: string): Promise<Buffer | null> {
  const { url, headers } = resolveSource(proxyUrl)
  let buf: Buffer
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
  if (!buf.subarray(0, 5).toString('ascii').startsWith('%PDF-')) return null
  return buf
}

/** Fetch the PDF at `proxyUrl` and return its text, or null on any failure. */
export async function pdfToText(proxyUrl: string): Promise<string | null> {
  const key = createHash('sha1').update(proxyUrl).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.txt`)
  try {
    return await readFile(cachePath, 'utf8')
  } catch {
    // miss — fetch + extract below
  }

  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) return null

  const dir = await mkdtemp(join(tmpdir(), 'zvg-pdftext-'))
  const inputPath = join(dir, 'in.pdf')
  try {
    await writeFile(inputPath, buf)
    const { stdout } = await exec('pdftotext', ['-layout', inputPath, '-'], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    await mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${cachePath}.tmp`
    await writeFile(tmp, stdout)
    await rename(tmp, cachePath)
    return stdout
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
