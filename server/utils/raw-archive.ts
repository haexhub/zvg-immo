// G1 Roh-Archiv Schicht 1: unveränderliches Archiv des vollständigen geparsten
// Auktions-Stands (raw_blobs = content-addressed Bytes, raw_captures =
// aktueller "welche Auktions-Identität zeigt auf welchen Blob"-Index).
// Best-effort wie recordObservations/matchAlerts: jeder exportierte Aufruf
// fängt seine eigenen Fehler und wirft nie. No-op ohne NUXT_DATABASE_URL (see
// server/utils/db.ts) — Blobs bleiben dann ungeschrieben, kein halbes Archiv.
//
// Schreibpfad: Bytes zuerst in eine lokale Outbox (schnell, netzunabhängig);
// server/utils/storage-uploader.ts drainiert sie später nach S3-compatible storage.

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

async function rollbackQuietly(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Preserve the original DB error; rollback failures are only secondary noise.
  }
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

    // Only a *confirmed* upload counts as "already archived". A Supabase
    // Storage outage before 2026-07-23 (Kong not yet routing /storage/v1/*,
    // see ansible#62/zvg-immo#122) let drainOutbox mark ~8000 blobs
    // `uploaded_at` even though the bytes never reached the bucket — and
    // then delete their outbox copy, as a confirmed upload normally warrants.
    // Skipping on row-existence alone (as before) would permanently orphan
    // any future capture whose content happens to hash-match one of those
    // dead rows: dedup would keep skipping the (re)write forever. A row
    // that's still `uploaded_at IS NULL` is safe to treat as not yet
    // archived and rewrite — the write below is idempotent, and
    // drainOutbox only ever trusts `uploaded_at`, never row presence.
    const existing = await db.query<{ uploaded_at: string | null }>(
      'SELECT uploaded_at FROM raw_blobs WHERE content_hash = $1',
      [hash],
    )
    if (existing.rows[0]?.uploaded_at != null) return hash

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
       ON CONFLICT (content_hash) DO UPDATE SET uploaded_at = null`,
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
 * Capture index. Auctions are keyed by `(kind, platform, externalId)` and
 * therefore represent the latest parsed auction state. Documents/detail/text
 * captures are keyed by `(kind, platform, externalId, sourceUrl, contentHash)`:
 * repeated crawls of the same bytes refresh metadata in place, but an updated
 * document behind the same URL remains as its own capture so document-set
 * versions can still point at older valid combinations. Never throws.
 */
export async function recordCapture(input: CaptureInput): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    const params = [
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
    ]
    const updateSet = `captured_at = EXCLUDED.captured_at,
         country      = EXCLUDED.country,
         region       = EXCLUDED.region,
         case_number  = EXCLUDED.case_number,
         authority    = EXCLUDED.authority,
         content_hash = EXCLUDED.content_hash,
         source_url   = EXCLUDED.source_url`
    const conflictTarget =
      input.kind === 'auction'
        ? `(kind, platform, external_id) WHERE kind = 'auction'`
        : `(kind, platform, external_id, (COALESCE(source_url, '')), content_hash) WHERE kind <> 'auction'`

    await db.query(
      `INSERT INTO raw_captures
         (captured_at, kind, platform, country, region, external_id, case_number, authority, content_hash, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         ${updateSet}`,
      params,
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

export interface ArchivedDocumentSetItem {
  ordinal: number
  kind: CaptureKind
  label: string | null
  filename: string | null
  fileId: string | null
  sourceUrl: string
  contentHash: string
  contentType: 'application/pdf' | 'application/vnd.docx'
}

export interface ArchivedDocumentSetResult {
  setHash: string
  version: number
  changed: boolean
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
): Promise<string | null> {
  const hash = await archiveBlob(bytes, contentType, identity.country)
  if (!hash) return null
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
  return hash
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
): Promise<string | null> {
  const hash = await archiveBlob(Buffer.from(text, 'utf8'), 'text/plain', identity.country)
  if (!hash) return null
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
  return hash
}

/**
 * Archives the current set of listing documents as one versioned manifest.
 * Individual document bytes remain content-addressed in raw_blobs; this table
 * records which hashes were valid together for the auction. Re-seeing the same
 * set only updates last_seen_at; a changed/added/withdrawn document produces
 * the next version. Never throws.
 */
export async function archiveDocumentSet(
  identity: DocumentIdentity,
  documents: ArchivedDocumentSetItem[],
  capturedAt: string,
): Promise<ArchivedDocumentSetResult | null> {
  const db = getPool()
  if (!db) return null
  try {
    const canonicalDocuments = documents
      .map((doc) => canonicalize({
        kind: doc.kind,
        label: doc.label ?? null,
        filename: doc.filename ?? null,
        fileId: doc.fileId ?? null,
        sourceUrl: doc.sourceUrl,
        contentHash: doc.contentHash,
        contentType: doc.contentType,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const setHash = sha256Hex(Buffer.from(JSON.stringify(canonicalize({ documents: canonicalDocuments }))))

    const existing = await db.query<{ id: string; version: number }>(
      `SELECT id, version
       FROM raw_document_sets
       WHERE platform = $1 AND external_id = $2 AND set_hash = $3`,
      [identity.platform, identity.externalId, setHash],
    )
    const existingRow = existing.rows[0]
    if (existingRow) {
      await db.query(
        `UPDATE raw_document_sets SET
           last_seen_at = $1,
           country = $2,
           region = $3,
           case_number = $4,
           authority = $5
         WHERE id = $6`,
        [
          capturedAt,
          identity.country,
          identity.region ?? null,
          identity.caseNumber ?? null,
          identity.authority ?? null,
          existingRow.id,
        ],
      )
      return { setHash, version: existingRow.version, changed: false }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const inserted = await client.query<{ id: string; version: number }>(
          `INSERT INTO raw_document_sets
             (captured_at, last_seen_at, platform, country, region, external_id, case_number, authority, set_hash, version, document_count)
           VALUES (
             $1, $1, $2, $3, $4, $5, $6, $7, $8,
             COALESCE((SELECT max(version) + 1 FROM raw_document_sets WHERE platform = $2 AND external_id = $5), 1),
             $9
           )
           RETURNING id, version`,
          [
            capturedAt,
            identity.platform,
            identity.country,
            identity.region ?? null,
            identity.externalId,
            identity.caseNumber ?? null,
            identity.authority ?? null,
            setHash,
            documents.length,
          ],
        )
        const row = inserted.rows[0]
        if (!row) {
          await client.query('COMMIT')
          return null
        }

        if (documents.length > 0) {
          const params: unknown[] = []
          const tuples: string[] = []
          for (const doc of documents) {
            const offset = params.length
            tuples.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`)
            params.push(
              row.id,
              doc.ordinal,
              doc.kind,
              doc.label ?? null,
              doc.filename ?? null,
              doc.fileId ?? null,
              doc.sourceUrl,
              doc.contentHash,
              doc.contentType,
            )
          }
          await client.query(
            `INSERT INTO raw_document_set_items
               (set_id, ordinal, kind, label, filename, file_id, source_url, content_hash, content_type)
             VALUES ${tuples.join(', ')}`,
            params,
          )
        }

        await client.query('COMMIT')
        return { setHash, version: row.version, changed: true }
      } catch (err) {
        await rollbackQuietly(client)
        if ((err as { code?: string }).code === '23505') {
          const winner = await db.query<{ id: string; version: number }>(
            `SELECT id, version
             FROM raw_document_sets
             WHERE platform = $1 AND external_id = $2 AND set_hash = $3`,
            [identity.platform, identity.externalId, setHash],
          )
          const winnerRow = winner.rows[0]
          if (winnerRow) return { setHash, version: winnerRow.version, changed: false }
          continue
        }
        throw err
      } finally {
        client.release()
      }
    }

    return null
  } catch (err) {
    console.warn(`[raw-archive] archiveDocumentSet failed: ${(err as Error).message}`)
    return null
  }
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
