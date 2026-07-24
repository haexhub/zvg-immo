// G1 Roh-Archiv Schicht 1: unveränderliches Archiv des vollständigen geparsten
// Auktions-Stands (raw_blobs = content-addressed Bytes, raw_captures =
// append-only "welche Auktions-Identität zeigte wann auf welchen Blob").
// Best-effort wie recordObservations/matchAlerts: jeder exportierte Aufruf
// fängt seine eigenen Fehler und wirft nie. No-op ohne NUXT_DATABASE_URL (see
// server/utils/db.ts) — Blobs bleiben dann ungeschrieben, kein halbes Archiv.
//
// Schreibpfad: Bytes zuerst in eine lokale Outbox (schnell, netzunabhängig);
// server/utils/storage-uploader.ts drainiert sie später nach Supabase Storage.

import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Auction } from '~/types/auction'
import { countryDisplayName } from './countries'
import { getPool } from './db'

export type BlobContentType =
  | 'application/json'
  | 'text/html'
  | 'application/pdf'
  | 'application/vnd.docx'
  | 'text/plain'

export type CaptureKind = 'auction' | 'document' | 'detail_html' | 'document_text'

// Text content is gzipped before storage (compresses well); PDF/DOCX are
// already compressed, stored as-is. `content_type` in raw_blobs records the
// stored (post-compression) type.
const TEXT_TYPES = new Set<BlobContentType>(['application/json', 'text/html', 'text/plain'])
// Exported for server/api/settings/archive/download/[id].get.ts, which needs
// the file extension for a Content-Disposition filename without duplicating
// this map.
export const EXT: Record<BlobContentType, string> = {
  'application/json': '.json',
  'text/html': '.html',
  'application/pdf': '.pdf',
  'application/vnd.docx': '.docx',
  'text/plain': '.txt',
}

function outboxDir(): string {
  return (useRuntimeConfig().rawOutboxDir as string | undefined) || join(process.cwd(), '.raw_outbox')
}

/** sha256 hex digest of `bytes`. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Sharded storage key, e.g. `Deutschland/ab/ab12…ef.json.gz` — country
 *  folder for manual browsing, then a hash-prefix shard so no single
 *  "directory" ends up with millions of keys. */
export function shardedKey(hash: string, contentType: BlobContentType, country: string): string {
  const gzip = TEXT_TYPES.has(contentType)
  const ext = EXT[contentType] + (gzip ? '.gz' : '')
  return `${countryDisplayName(country)}/${hash.slice(0, 2)}/${hash}${ext}`
}

export function storedContentType(contentType: BlobContentType): string {
  return TEXT_TYPES.has(contentType) ? `${contentType}+gzip` : contentType
}

/**
 * Recursively sorts object keys so `JSON.stringify` is deterministic
 * regardless of property insertion order. Arrays keep their order — element
 * order can itself be meaningful (e.g. attachment order changing upstream).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Canonical auction content for hashing: stable key order, and stripped of
 * fields that are per-run bookkeeping or derived rather than source content —
 * `detailFetchedAt` (a timestamp, not data), `extraction` (derived, layered on
 * read by /api/auctions, never present on the crawled object itself), and
 * `marketValueEur` (derived from `marketValue`+`currency` via *live* ECB rates
 * in `deriveMarketValueEur`, so it drifts every run for non-EUR auctions). The
 * source of truth for the price — `marketValue`+`currency` — stays in the hash,
 * so real price changes are still detected. Without these strips, a mere FX
 * tick or timestamp would mint a new blob on every run even when nothing about
 * the auction actually changed.
 */
export function canonicalizeAuction(auction: Auction): unknown {
  const {
    detailFetchedAt: _detailFetchedAt,
    extraction: _extraction,
    marketValueEur: _marketValueEur,
    ...rest
  } = auction
  return canonicalize(rest)
}

/**
 * Content-hash-dedup a blob into the archive. Computes sha256 over
 * `opts.canonicalBytesForHash` (falls back to `bytes`) so a caller can hash a
 * normalized form while storing the bytes as originally captured. Gzips text
 * content, writes it to the local outbox (atomic tmp+rename), and inserts the
 * `raw_blobs` index row. Existing hashes are recognized and skipped — the
 * whole point of content-hash-dedup.
 *
 * Never throws; returns null when archiving is unavailable (no DB) or on any
 * failure — archiving is strictly best-effort and must never break a crawl.
 */
export async function archiveBlob(
  bytes: Buffer,
  contentType: BlobContentType,
  country: string,
  opts?: { canonicalBytesForHash?: Buffer },
): Promise<string | null> {
  const db = getPool()
  if (!db) return null
  try {
    const hash = sha256Hex(opts?.canonicalBytesForHash ?? bytes)

    const existing = await db.query('SELECT 1 FROM raw_blobs WHERE content_hash = $1', [hash])
    if ((existing.rowCount ?? 0) > 0) return hash

    const gzip = TEXT_TYPES.has(contentType)
    const stored = gzip ? gzipSync(bytes) : bytes
    const key = shardedKey(hash, contentType, country)

    const path = join(outboxDir(), key)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, stored)
    await rename(tmp, path)

    await db.query(
      `INSERT INTO raw_blobs (content_hash, s3_key, content_type, byte_size, first_seen_at, uploaded_at)
       VALUES ($1, $2, $3, $4, now(), null)
       ON CONFLICT (content_hash) DO NOTHING`,
      [hash, key, storedContentType(contentType), stored.length],
    )
    return hash
  } catch (err) {
    console.warn(`[raw-archive] archiveBlob failed: ${(err as Error).message}`)
    return null
  }
}

export interface CaptureInput {
  capturedAt: string
  kind: CaptureKind
  platform: string
  country: string
  region?: string | null
  externalId: string
  caseNumber?: string | null
  authority?: string | null
  contentHash: string
  sourceUrl?: string | null
}

/**
 * Append-only capture log, keyed on `(kind, platform, externalId,
 * contentHash)` (unique index in schema.sql): a hash never seen before for
 * this identity inserts a new history row; a hash seen before upserts in
 * place via `ON CONFLICT ... DO UPDATE`, refreshing captured_at and the
 * metadata columns (region, case_number, authority, source_url) instead of
 * leaving them stale. That refresh matters even on the common "nothing
 * changed" path: for `kind='document'`/`'document_text'` the content hash is
 * over the document bytes, not the auction identity, so the same PDF can be
 * re-captured after the auction's region/case_number was corrected upstream
 * with the document itself never changing — an early return on unchanged
 * hash (as a naive change-only log would do) would freeze that stale
 * metadata on the row forever. `refresh.ts` and `enrich.ts` can also call
 * this concurrently for the same auction; the unique index + upsert (rather
 * than a check-then-insert) is what makes that race safe. Never throws.
 */
export async function recordCapture(input: CaptureInput): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      `INSERT INTO raw_captures
         (captured_at, kind, platform, country, region, external_id, case_number, authority, content_hash, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (kind, platform, external_id, content_hash) DO UPDATE SET
         captured_at = EXCLUDED.captured_at,
         region      = EXCLUDED.region,
         case_number = EXCLUDED.case_number,
         authority   = EXCLUDED.authority,
         source_url  = EXCLUDED.source_url`,
      [
        input.capturedAt,
        input.kind,
        input.platform,
        input.country,
        input.region || null,
        input.externalId,
        input.caseNumber ?? null,
        input.authority ?? null,
        input.contentHash,
        input.sourceUrl ?? null,
      ],
    )
  } catch (err) {
    console.warn(`[raw-archive] recordCapture failed: ${(err as Error).message}`)
  }
}

export interface DocumentIdentity {
  platform: string
  country: string
  region?: string | null
  externalId: string
  caseNumber?: string | null
  authority?: string | null
}

/**
 * Archives a PDF/DOCX attachment's raw bytes (`kind='document'`), keyed on
 * the auction whose enrichment fetched it. Content-hash-dedup means the same
 * appraisal document shared across multiple auctions (or re-fetched
 * unchanged on a later run) is stored once, while each referencing auction
 * still gets its own capture row. Never throws.
 */
export async function archiveDocument(
  bytes: Buffer,
  contentType: 'application/pdf' | 'application/vnd.docx',
  identity: DocumentIdentity,
  sourceUrl: string,
  capturedAt: string,
): Promise<void> {
  const hash = await archiveBlob(bytes, contentType, identity.country)
  if (!hash) return
  await recordCapture({
    capturedAt,
    kind: 'document',
    platform: identity.platform,
    country: identity.country,
    region: identity.region ?? null,
    externalId: identity.externalId,
    caseNumber: identity.caseNumber ?? null,
    authority: identity.authority ?? null,
    contentHash: hash,
    sourceUrl,
  })
}

/**
 * Archives a document's canonically extracted text (pdftotext/OCR output,
 * `kind='document_text'`) — the Stufe-1-Normalisierung output described in
 * docs/plans/2026-07-22-de-crawler-photos-cards-plan.md (WP-B). Lets
 * reprocessing read already-extracted text instead of re-running
 * pdftotext/OCR on the raw PDF bytes. Never throws.
 */
export async function archiveDocumentText(
  text: string,
  identity: DocumentIdentity,
  sourceUrl: string,
  capturedAt: string,
): Promise<void> {
  const hash = await archiveBlob(Buffer.from(text, 'utf8'), 'text/plain', identity.country)
  if (!hash) return
  await recordCapture({
    capturedAt,
    kind: 'document_text',
    platform: identity.platform,
    country: identity.country,
    region: identity.region ?? null,
    externalId: identity.externalId,
    caseNumber: identity.caseNumber ?? null,
    authority: identity.authority ?? null,
    contentHash: hash,
    sourceUrl,
  })
}

/**
 * Archives the full parsed auction state, keyed on `(platform, externalId)`.
 * Called once from `refresh.ts` per crawled auction (listing-level) and again
 * from `enrich.ts` after a successful `enrichOne` (detail-level) — the second
 * call produces a new content hash whenever detail data (description,
 * attachments, source* fields, ...) was added, so both the listing snapshot
 * and the enriched snapshot end up in the archive. Never throws.
 */
export async function archiveAuction(auction: Auction, capturedAt: string): Promise<void> {
  try {
    const canonicalBytes = Buffer.from(JSON.stringify(canonicalizeAuction(auction)))
    const bytes = Buffer.from(JSON.stringify(auction))
    const hash = await archiveBlob(bytes, 'application/json', auction.country, { canonicalBytesForHash: canonicalBytes })
    if (!hash) return

    await recordCapture({
      capturedAt,
      kind: 'auction',
      platform: auction.platform,
      country: auction.country,
      region: auction.region,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber || null,
      authority: auction.authority || null,
      contentHash: hash,
      sourceUrl: auction.detailUrlUpstream ?? null,
    })
  } catch (err) {
    console.warn(`[raw-archive] archiveAuction failed: ${(err as Error).message}`)
  }
}
