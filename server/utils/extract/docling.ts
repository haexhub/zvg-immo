// Turns archived PDF bytes into structured Markdown via a sibling
// docling-serve container, so the LLM gets tables as tables instead of
// whitespace-aligned prose (pdftotext) or raw PDF bytes it has to parse itself.
//
// Why a separate service: Docling is Python and ships ~2 GB of layout/table
// models. Measured on prod hardware (2026-07-31): ~2.1 GB resident for the
// loaded models plus ~10 MB per page, ~6 s/page with a text layer and
// ~20 s/page when OCR runs. That is far too expensive to do inline per
// request, hence the content-hash-keyed cache in document_markdown (see
// markdownForPdf below) — every distinct PDF is converted exactly once.
//
// Unconfigured (no NUXT_DOCLING_URL) or unreachable → every function here
// resolves to null and callers fall back to their previous behaviour. This
// step must never be able to break extraction.

import type { Pool } from 'pg'
import { archiveBlob } from '../raw-archive'
import { downloadBlob } from '../storage-download'

/** Countries whose scans Docling's OCR cannot currently read well enough to
 *  replace the previous path. Measured 2026-07-31 on archived Bulgarian
 *  documents: the auto-selected RapidOCR model returns numbers, dates and
 *  IBANs but drops Cyrillic prose almost entirely, which is a regression
 *  against handing the raw PDF to a provider that reads it natively. Revisit
 *  once ocr_lang/Tesseract-bul is configured and re-measured. */
const DOCLING_EXCLUDED_COUNTRIES = new Set(['bg'])

/** A 143-page scan (the largest in the archive) needs several minutes on CPU;
 *  this bounds a single conversion rather than reflecting a target latency. */
const DOCLING_TIMEOUT_MS = 900_000

/**
 * Conversions run one at a time process-wide. A single one already saturates
 * the CPU and holds ~2-3 GB resident in the Docling container (measured
 * 2026-07-31: 2.48 GB for 37 pages, 2.82 GB for 10 OCR'd pages), so letting an
 * auction's document set convert concurrently would multiply peak memory and
 * OOM the service — which is exactly what happened on the test box with its
 * two default workers. Callers stay parallel; only this step queues.
 */
let conversionQueue: Promise<unknown> = Promise.resolve()

function serializeConversion<T>(run: () => Promise<T>): Promise<T> {
  const next = conversionQueue.then(run, run)
  conversionQueue = next.catch(() => undefined)
  return next
}

export function doclingBaseUrl(): string | null {
  // Guarded because this sits on the document-preparation path, which must
  // degrade rather than throw: outside a Nitro request context (unit tests,
  // standalone scripts) useRuntimeConfig() isn't defined at all, and Docling
  // being unavailable is a valid state, not an error.
  try {
    const url = String(useRuntimeConfig().doclingUrl ?? '').trim()
    return url ? url.replace(/\/$/, '') : null
  } catch {
    return null
  }
}

export function doclingSupportsCountry(country: string | null | undefined): boolean {
  return !DOCLING_EXCLUDED_COUNTRIES.has((country ?? '').toLowerCase())
}

interface DoclingConvertResponse {
  document?: { md_content?: string | null }
  status?: string
  errors?: unknown[]
}

export interface DoclingConversion {
  markdown: string | null
  /** True only when Docling answered (2xx) but produced no usable Markdown —
   *  that document genuinely cannot be converted, so markdownForPdf may
   *  permanently cache the failure. False for every other case (unconfigured,
   *  unreachable, non-2xx, thrown error): those are transient outages and
   *  must not blacklist a PDF that a retry could still convert. */
  terminal: boolean
}

/**
 * Converts PDF bytes to Markdown. Never throws — unconfigured, unreachable,
 * non-2xx and thrown errors all resolve to `{ markdown: null, terminal: false }`;
 * only a successful response with no Markdown content is `terminal: true`.
 *
 * Defaults are deliberate: `do_ocr` is left on so scanned documents (11.9 % of
 * the archive) produce text at all, and `table_mode=accurate` is the reason
 * this service exists in the first place. `image_export_mode=placeholder`
 * keeps embedded images out of the Markdown — photo extraction stays with the
 * existing pdfimages pipeline (server/utils/extract/pdf-images.ts).
 */
export async function convertPdfToMarkdown(bytes: Buffer, label: string): Promise<DoclingConversion> {
  const baseUrl = doclingBaseUrl()
  if (!baseUrl) return { markdown: null, terminal: false }

  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), label)
  form.append('to_formats', 'md')
  form.append('table_mode', 'accurate')
  form.append('image_export_mode', 'placeholder')

  try {
    const res = await serializeConversion(() => fetch(`${baseUrl}/v1/convert/file`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(DOCLING_TIMEOUT_MS),
    }))
    if (!res.ok) {
      console.warn(`[docling] ${label}: HTTP ${res.status}`)
      return { markdown: null, terminal: false }
    }
    const body = (await res.json()) as DoclingConvertResponse
    const markdown = body.document?.md_content?.trim()
    if (!markdown) {
      console.warn(`[docling] ${label}: response carried no markdown (status=${body.status ?? '?'})`)
      return { markdown: null, terminal: true }
    }
    return { markdown, terminal: false }
  } catch (err) {
    console.warn(`[docling] ${label}: ${(err as Error).message}`)
    return { markdown: null, terminal: false }
  }
}

interface CachedMarkdown {
  markdownContentHash: string | null
  failed: boolean
}

async function readCachedMarkdown(db: Pool, pdfContentHash: string): Promise<CachedMarkdown | null> {
  const { rows } = await db.query<{ markdown_content_hash: string | null; failed_at: Date | null }>(
    'SELECT markdown_content_hash, failed_at FROM document_markdown WHERE pdf_content_hash = $1',
    [pdfContentHash],
  )
  const row = rows[0]
  if (!row) return null
  return { markdownContentHash: row.markdown_content_hash, failed: row.failed_at != null }
}

async function recordConversion(
  db: Pool,
  pdfContentHash: string,
  markdownContentHash: string | null,
  error: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO document_markdown (pdf_content_hash, markdown_content_hash, converted_at, failed_at, error)
     VALUES ($1, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $2::text IS NULL THEN now() ELSE NULL END, $3)
     ON CONFLICT (pdf_content_hash) DO UPDATE
       SET markdown_content_hash = EXCLUDED.markdown_content_hash,
           converted_at = EXCLUDED.converted_at,
           failed_at = EXCLUDED.failed_at,
           error = EXCLUDED.error`,
    [pdfContentHash, markdownContentHash, error],
  )
}

/**
 * Markdown for an already-archived PDF, converting it once and caching the
 * result against the PDF's content hash. A previously failed conversion is
 * not retried — Docling costs minutes per document, so a PDF it cannot read
 * must not be re-attempted on every hourly reprocess run. Clear the row to
 * force a retry.
 *
 * `bytes` is only read when the cache misses, so callers that already hold the
 * blob pass it in rather than making this function re-download it.
 */
export async function markdownForPdf(
  db: Pool | null,
  pdfContentHash: string | null,
  bytes: Buffer,
  opts: { label: string; country: string | null | undefined },
): Promise<string | null> {
  if (!doclingBaseUrl() || !doclingSupportsCountry(opts.country)) return null

  // No DB (dev/tests) → convert without caching rather than skipping, so the
  // behaviour stays observable. An unknown content hash means we have nothing
  // to key a cache entry on and takes the same path.
  if (!db || !pdfContentHash) return (await convertPdfToMarkdown(bytes, opts.label)).markdown

  const cached = await readCachedMarkdown(db, pdfContentHash).catch((err) => {
    console.warn(`[docling] cache read failed for ${pdfContentHash}: ${(err as Error).message}`)
    return null
  })
  if (cached?.failed) return null
  if (cached?.markdownContentHash) {
    const blob = await downloadBlob(cached.markdownContentHash)
    if (blob) return blob.toString('utf8')
    // Cache row without readable bytes (blob lost/not yet uploaded) — fall
    // through and convert again rather than silently dropping the document.
  }

  const conversion = await convertPdfToMarkdown(bytes, opts.label)
  if (!conversion.markdown) {
    // Only a terminal failure (Docling responded, the document just has no
    // usable content) is worth caching — a transient outage must not
    // blacklist a PDF that a later retry could still convert.
    if (conversion.terminal) {
      await recordConversion(db, pdfContentHash, null, 'conversion returned no markdown').catch(() => undefined)
    }
    return null
  }
  const markdown = conversion.markdown
  // text/plain like archiveDocumentText's extracted prose — gzipped by
  // archiveBlob, and the archive browser already knows how to serve it.
  const markdownHash = await archiveBlob(Buffer.from(markdown, 'utf8'), 'text/plain', opts.country ?? 'unknown')
    .catch(() => null)
  if (markdownHash) {
    await recordConversion(db, pdfContentHash, markdownHash, null).catch(() => undefined)
  }
  return markdown
}
