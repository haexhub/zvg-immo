// Fetches an attachment PDF and extracts its text with poppler's `pdftotext`
// (already in the runtime image, used by /api/zvg-thumb). Results are cached on
// disk keyed by the attachment URL so a re-processed auction never re-downloads.
//
// Attachment URLs differ by platform: zvg-portal stores a relative
// `/api/zvg-proxy?…` path (the upstream needs a specific Referer), while AT,
// zvbawü and Biddit store absolute, directly-fetchable URLs. resolveSource
// handles both.

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Attachment } from '~/types/auction'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'
import { archiveDocument, archiveDocumentText, type DocumentIdentity } from '../raw-archive'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdftext')

/** Attachment kinds whose PDF most likely carries the size/type facts, best first. */
const PDF_KIND_PRIORITY = ['appraisal', 'brochure', 'announcement', 'other'] as const
const SUMMARY_PDF_KINDS = new Set(['appraisal', 'brochure', 'announcement'])

/** Pick the attachment whose PDF is most likely to describe the property. */
export function pickBestPdf(attachments: Attachment[]): Attachment | null {
  for (const kind of PDF_KIND_PRIORITY) {
    const hit = attachments.find((a) => a.kind === kind)
    if (hit) return hit
  }
  return null
}

/**
 * Every listing-specific PDF that can contribute facts to the description,
 * ordered from richest to most formal. Generic court-wide "other" documents
 * (e.g. Biethinweise) are deliberately excluded.
 */
export function pickRelevantPdfs(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const kind of PDF_KIND_PRIORITY) {
    if (!SUMMARY_PDF_KINDS.has(kind)) continue
    for (const attachment of attachments) {
      if (attachment.kind !== kind || seen.has(attachment.proxyUrl)) continue
      seen.add(attachment.proxyUrl)
      out.push(attachment)
    }
  }
  return out
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
    // Bound the fetch: a slow upstream would otherwise hang both text and
    // photo extraction (the enrich task uses Promise.all across workers, so
    // one stuck request stalls the whole run).
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
  if (!buf.subarray(0, 5).toString('ascii').startsWith('%PDF-')) return null
  return buf
}

/**
 * Runs `pdftotext` directly on in-memory PDF bytes — no fetch, no disk cache.
 * Used by `pdfToText` below (after its own fetch) and by the reprocessing
 * task (server/tasks/reprocess.ts), which already has the bytes from the raw
 * archive and must not re-fetch from the live portal.
 */
export async function extractPdfTextFromBuffer(buf: Buffer): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'zvg-pdftext-'))
  const inputPath = join(dir, 'in.pdf')
  try {
    await writeFile(inputPath, buf)
    const { stdout } = await exec('pdftotext', ['-layout', inputPath, '-'], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Fetch the PDF at `proxyUrl` and return its text, or null on any failure.
 * When `archive` is given, the raw PDF bytes are captured into the G1 archive
 * (kind='document') right at the point they're actually fetched, and — once
 * pdftotext succeeds with non-blank output — the extracted text is captured
 * too (kind='document_text'), so a later reprocess can read it back without
 * re-running pdftotext. A cache hit on the text below skips the fetch
 * entirely, so it never re-archives an already-seen PDF just to serve cached
 * text.
 */
export async function pdfToText(
  proxyUrl: string,
  archive?: { identity: DocumentIdentity; capturedAt: string },
): Promise<string | null> {
  const key = createHash('sha1').update(proxyUrl).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.txt`)
  try {
    return await readFile(cachePath, 'utf8')
  } catch {
    // miss — fetch + extract below
  }

  const buf = await fetchPdfBuffer(proxyUrl)
  if (!buf) return null
  if (archive) {
    await archiveDocument(buf, 'application/pdf', archive.identity, proxyUrl, archive.capturedAt)
  }

  const stdout = await extractPdfTextFromBuffer(buf)
  if (stdout == null) return null
  if (archive && stdout.trim()) {
    await archiveDocumentText(stdout, archive.identity, proxyUrl, archive.capturedAt)
  }
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${cachePath}.${randomUUID()}.tmp`
    await writeFile(tmp, stdout)
    await rename(tmp, cachePath)
    return stdout
  } catch {
    return null
  }
}
