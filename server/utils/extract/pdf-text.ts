// Fetches an attachment PDF and extracts its text with poppler's `pdftotext`
// (already in the runtime image, used by /api/zvg-thumb). Results are cached on
// disk keyed by the attachment URL so a re-processed auction never re-downloads.
//
// Attachment URLs differ by platform. ZVG Portal uses an absolute source URL
// that needs a specific Referer, while AT, zvbawü and Biddit are directly
// fetchable. resolveSource also understands legacy persisted proxy strings
// during the database transition; they are never exposed by public APIs.

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Attachment } from '~/types/auction'
import { BASE_URL as DGA_AG_BASE_URL } from '~/server/crawlers/dga-ag/constants'
import { getDgaAgSessionCookie, isDgaAgLoginRedirect } from '~/server/crawlers/dga-ag/session'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'
import { archiveDocument, archiveDocumentText, type DocumentIdentity } from '../raw-archive'

const exec = promisify(execFile)
const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdftext')
const MAX_PDF_BYTES = 50 * 1024 * 1024

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

function isPdfAttachment(attachment: Attachment): boolean {
  return /\.pdf(?:[?#]|$)/i.test(attachment.filename ?? '') || /\.pdf(?:[?#]|$)/i.test(attachment.proxyUrl)
}

/**
 * Every auction-specific PDF attachment, ordered predictably but without
 * dropping "other" documents. Used for full LLM analysis where recall matters
 * more than the old "best/relevant document" shortcut.
 */
export function pickAllPdfs(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const kind of PDF_KIND_PRIORITY) {
    for (const attachment of attachments) {
      if (attachment.kind !== kind || !isPdfAttachment(attachment) || seen.has(attachment.proxyUrl)) continue
      seen.add(attachment.proxyUrl)
      out.push(attachment)
    }
  }
  for (const attachment of attachments) {
    if (!isPdfAttachment(attachment) || seen.has(attachment.proxyUrl)) continue
    seen.add(attachment.proxyUrl)
    out.push(attachment)
  }
  return out
}

async function resolveSource(proxyUrl: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (proxyUrl.startsWith('/api/zvg-proxy')) {
    const q = new URLSearchParams(proxyUrl.split('?')[1] ?? '')
    const url = `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${q.get('land_abk')}&file_id=${q.get('file_id')}&zvg_id=${q.get('zvg_id')}`
    return { url, headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: `${ZVG_BASE}/index.php?button=Suchen` } }
  }
  if (proxyUrl.startsWith(`${ZVG_BASE}/`)) {
    return {
      url: proxyUrl,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: `${ZVG_BASE}/index.php?button=Suchen` },
    }
  }
  // dga-ag.de's per-object "Objektunterlagen" PDF (detail.ts) sits behind the
  // same felogin session that unlocked it on the detail page — the signed
  // URL's own JWT alone is not enough (verified live: it 302s to /login.html
  // without this cookie).
  if (proxyUrl.startsWith(`${DGA_AG_BASE_URL}/securedl/`)) {
    const cookie = await getDgaAgSessionCookie()
    return {
      url: proxyUrl,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', ...(cookie ? { Cookie: cookie } : {}) },
    }
  }
  return { url: proxyUrl, headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' } }
}

async function fetchPdfBufferAttempt(
  url: string,
  headers: Record<string, string>,
): Promise<{ buf: Buffer | null; finalUrl: string | null }> {
  let buf: Buffer
  let finalUrl: string | null = null
  try {
    // Bound the fetch: a slow upstream would otherwise hang both text and
    // photo extraction (the enrich task uses Promise.all across workers, so
    // one stuck request stalls the whole run).
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    finalUrl = res.url || null
    if (!res.ok) return { buf: null, finalUrl }
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      return { buf: null, finalUrl }
    }
    if (!res.body) {
      buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_PDF_BYTES) return { buf: null, finalUrl }
    } else {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_PDF_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { buf: null, finalUrl }
        }
        chunks.push(value)
      }
      buf = Buffer.concat(chunks, total)
    }
  } catch {
    return { buf: null, finalUrl }
  }
  if (!buf.subarray(0, 5).toString('ascii').startsWith('%PDF-')) return { buf: null, finalUrl }
  return { buf, finalUrl }
}

/**
 * Fetch the PDF at `proxyUrl` and return its bytes, or null on any failure
 * (network error, non-200, non-PDF response). Retries once with a freshly
 * forced dga-ag session if the first attempt lands on the login page.
 */
export async function fetchPdfBuffer(proxyUrl: string): Promise<Buffer | null> {
  const { url, headers } = await resolveSource(proxyUrl)
  const first = await fetchPdfBufferAttempt(url, headers)
  if (first.buf || !isDgaAgLoginRedirect(proxyUrl, first.finalUrl)) return first.buf
  await getDgaAgSessionCookie({ forceRefresh: true })
  const retry = await resolveSource(proxyUrl)
  return (await fetchPdfBufferAttempt(retry.url, retry.headers)).buf
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

// Adobe's predefined CJK CID encodings (Shift-JIS/GB/CNS/KS CMaps) — never
// legitimate for a European real-estate document. Some scanner OCR software
// (observed: a Canon copier's built-in OCR) mismaps Cyrillic/Latin text onto
// a CJK font with one of these encodings; poppler still decodes *something*
// from it (plenty of characters, so the plain length check below never
// catches it) but the result is homoglyph noise, not real text.
const CJK_CID_ENCODING_RE = /RKSJ|UniGB|UniCNS|UniJIS|UniKS|EUC-|KSC/i

/**
 * Whether this PDF's fonts look trustworthy, i.e. none uses a CJK CID
 * encoding — a strong signal that its text layer is bogus (see
 * CJK_CID_ENCODING_RE above). Fails open (true = "trust the text") so a
 * missing/erroring `pdffonts` never makes extraction worse than before this
 * check existed.
 */
export async function pdfHasTrustworthyEncoding(buf: Buffer): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'zvg-pdffonts-'))
  const inputPath = join(dir, 'in.pdf')
  try {
    await writeFile(inputPath, buf)
    const { stdout } = await exec('pdffonts', [inputPath], {
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    return !stdout
      .split('\n')
      .slice(2)
      // Columns: name type encoding emb sub uni objectID gen — name/type can
      // themselves contain spaces (e.g. "CID TrueType"), so count the fixed-
      // width tail columns from the end rather than indexing from the start.
      .some((line) => CJK_CID_ENCODING_RE.test(line.trim().split(/\s+/).at(-6) ?? ''))
  } catch {
    return true
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
