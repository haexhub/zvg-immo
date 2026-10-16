// G1 Roh-Archiv Schicht 1: unveränderliches Archiv des vollständigen geparsten
// Auktions-Stands (artifact_blobs = content-addressed Bytes, artifact_captures =
// append-only "welche Auktions-Identität zeigt auf welchen Blob"-Index).
// Ohne NUXT_DATABASE_URL (siehe server/utils/db.ts) bleibt die Schicht
// deaktiviert. Sobald eine Datenbank konfiguriert ist, werden Schreibfehler
// bewusst weitergeworfen: Ein Crawl darf bei verlorenen Quelldaten nicht
// fälschlich als erfolgreich erscheinen.
//
// Schreibpfad: Bytes zuerst in eine lokale Outbox (schnell, netzunabhängig);
// server/utils/storage-uploader.ts drainiert sie später nach S3-compatible storage.

import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { and, eq, sql } from 'drizzle-orm'
import type { Auction } from '~/types/auction'
import { artifactBlobs, artifactVersionItems, artifactVersions } from '../db/schema'
import { countryDisplayName } from './countries'
import { getDb, pgErrorCode } from './db'

export type BlobContentType =
  | 'application/json'
  | 'text/html'
  | 'application/octet-stream'
  | 'application/pdf'
  | 'application/vnd.docx'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'text/plain'

export type CaptureKind = 'auction' | 'document' | 'detail_html' | 'document_text' | 'photo'

// Text content is gzipped before storage (compresses well); PDF/DOCX are
// already compressed, stored as-is. `content_type` in artifact_blobs records the
// stored (post-compression) type.
const TEXT_TYPES = new Set<BlobContentType>(['application/json', 'text/html', 'text/plain'])
// Exported for server/api/settings/archive/download/[id].get.ts, which needs
// the file extension for a Content-Disposition filename without duplicating
// this map.
export const EXT: Record<BlobContentType, string> = {
  'application/json': '.json',
  'text/html': '.html',
  'application/octet-stream': '.bin',
  'application/pdf': '.pdf',
  'application/vnd.docx': '.docx',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
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
 * `artifact_blobs` index row. Existing hashes are recognized and skipped — the
 * whole point of content-hash-dedup.
 *
 * Returns null only when archiving is unavailable because no database is
 * configured. Once a database is configured, persistence failures are thrown:
 * a crawl must not report success after silently losing source data.
 */
export async function archiveBlob(
  bytes: Buffer,
  contentType: BlobContentType,
  country: string,
  opts?: { canonicalBytesForHash?: Buffer },
): Promise<string | null> {
  const db = getDb()
  if (!db) return null
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
  const existing = await db.select({ uploadedAt: artifactBlobs.uploadedAt })
    .from(artifactBlobs)
    .where(eq(artifactBlobs.contentHash, hash))
  if (existing[0]?.uploadedAt != null) return hash

  const gzip = TEXT_TYPES.has(contentType)
  const stored = gzip ? gzipSync(bytes) : bytes
  const key = shardedKey(hash, contentType, country)

  const path = join(outboxDir(), key)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, stored)
  await rename(tmp, path)

  await db.insert(artifactBlobs).values({
    contentHash: hash,
    s3Key: key,
    contentType: storedContentType(contentType),
    byteSize: stored.length,
    firstSeenAt: sql`now()`,
    uploadedAt: null,
  }).onConflictDoUpdate({ target: artifactBlobs.contentHash, set: { uploadedAt: null } })
  return hash
}

// region/caseNumber/authority are no longer persisted — they live on the
// `auctions` identity row since WP-1 and are read back by JOIN. `country` is
// still required: it selects the storage folder in shardedKey().
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
 * Capture index, append-only. Auctions are keyed by `(kind, platform,
 * externalId, contentHash)`: a repeated crawl with the same content_hash only
 * refreshes metadata (captured_at/source_url) in place, but a real change to
 * the parsed auction produces a new content hash and therefore a new version
 * row — old versions are never overwritten (the unique index makes this
 * race-safe). Documents/detail/text captures are keyed by `(kind, platform,
 * externalId, sourceUrl, contentHash)`: repeated crawls of the same bytes
 * refresh metadata in place, but an updated document behind the same URL
 * remains as its own capture so document-set versions can still point at
 * older valid combinations. Persistence failures propagate.
 */
export async function recordCapture(input: CaptureInput): Promise<void> {
  const db = getDb()
  if (!db) return
  // The partial-unique-index conflict target below (predicate + a
  // COALESCE expression for the non-auction case) can't be expressed
  // through the typed insert builder's onConflictDoUpdate(), which only
  // accepts plain columns as a target — hence the raw fragment here, same
  // as the matching partial indexes in server/db/schema/core.ts.
  const conflictTarget = input.kind === 'auction'
    ? sql.raw(`(kind, platform, external_id, content_hash) WHERE kind = 'auction'`)
    : sql.raw(`(kind, platform, external_id, (COALESCE(source_url, '')), content_hash) WHERE kind <> 'auction'`)

  await db.execute(sql`
    INSERT INTO artifact_captures
      (captured_at, kind, platform, external_id, content_hash, source_url)
    VALUES (${input.capturedAt}, ${input.kind}, ${input.platform}, ${input.externalId}, ${input.contentHash}, ${input.sourceUrl ?? null})
    ON CONFLICT ${conflictTarget} DO UPDATE SET
      captured_at = EXCLUDED.captured_at,
      content_hash = EXCLUDED.content_hash,
      source_url = EXCLUDED.source_url
  `)
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
  contentType: BlobContentType
}

export interface ArchivedDocumentSetResult {
  setHash: string
  version: number
  changed: boolean
}

/**
 * Archives an attachment's raw bytes (`kind='document'`), keyed on
 * the auction whose enrichment fetched it. Content-hash-dedup means the same
 * appraisal/document shared across multiple auctions (or re-fetched
 * unchanged on a later run) is stored once, while each referencing auction
 * still gets its own capture row. Persistence failures propagate.
 */
export async function archiveDocumentBlob(
  bytes: Buffer,
  contentType: BlobContentType,
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
 * Archives a photo's raw bytes (`kind='photo'`). Unlike documents, no
 * `sourceUrl` is required: photos are deduplicated by content hash alone, and
 * several source URLs (native crawler photo, document-extracted photo) can
 * legitimately point at the same bytes — the source URL isn't a meaningful
 * identity here. Persistence failures propagate.
 */
export async function archivePhotoBlob(
  bytes: Buffer,
  contentType: 'image/jpeg' | 'image/png' | 'image/webp',
  identity: DocumentIdentity,
  capturedAt: string,
): Promise<string | null> {
  const hash = await archiveBlob(bytes, contentType, identity.country)
  if (!hash) return null
  await recordCapture({
    capturedAt,
    kind: 'photo',
    platform: identity.platform,
    country: identity.country,
    region: identity.region ?? null,
    externalId: identity.externalId,
    caseNumber: identity.caseNumber ?? null,
    authority: identity.authority ?? null,
    contentHash: hash,
    sourceUrl: null,
  })
  return hash
}

export async function archiveDocument(
  bytes: Buffer,
  contentType: 'application/pdf' | 'application/vnd.docx',
  identity: DocumentIdentity,
  sourceUrl: string,
  capturedAt: string,
): Promise<string | null> {
  return archiveDocumentBlob(bytes, contentType, identity, sourceUrl, capturedAt)
}

/**
 * Archives a document's canonically extracted text (pdftotext/OCR output,
 * `kind='document_text'`) — the Stufe-1-Normalisierung output described in
 * docs/plans/2026-07-22-de-crawler-photos-cards-plan.md (WP-B). Lets
 * reprocessing read already-extracted text instead of re-running
 * pdftotext/OCR on the raw PDF bytes. Persistence failures propagate.
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
 * Individual document bytes remain content-addressed in artifact_blobs; this table
 * records which hashes were valid together for the auction. Re-seeing the same
 * set only updates last_seen_at; a changed/added/withdrawn document produces
 * the next version. Persistence failures propagate.
 */
export async function archiveDocumentSet(
  identity: DocumentIdentity,
  documents: ArchivedDocumentSetItem[],
  capturedAt: string,
): Promise<ArchivedDocumentSetResult | null> {
  const db = getDb()
  if (!db) return null
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

    const identityMatch = () => and(
      eq(artifactVersions.platform, identity.platform),
      eq(artifactVersions.externalId, identity.externalId),
      eq(artifactVersions.setHash, setHash),
    )

    const existing = await db.select({ id: artifactVersions.id, version: artifactVersions.version })
      .from(artifactVersions)
      .where(identityMatch())
    const existingRow = existing[0]
    if (existingRow) {
      await db.update(artifactVersions).set({ lastSeenAt: new Date(capturedAt) }).where(eq(artifactVersions.id, existingRow.id))
      return { setHash, version: existingRow.version, changed: false }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx.insert(artifactVersions).values({
            capturedAt: new Date(capturedAt),
            lastSeenAt: new Date(capturedAt),
            platform: identity.platform,
            externalId: identity.externalId,
            setHash,
            version: sql`coalesce((select max(version) + 1 from ${artifactVersions} where platform = ${identity.platform} and external_id = ${identity.externalId}), 1)`,
            documentCount: documents.length,
          }).returning({ id: artifactVersions.id, version: artifactVersions.version })
          if (!row) return null

          if (documents.length > 0) {
            await tx.insert(artifactVersionItems).values(documents.map((doc) => ({
              setId: row.id,
              ordinal: doc.ordinal,
              kind: doc.kind,
              label: doc.label ?? null,
              filename: doc.filename ?? null,
              fileId: doc.fileId ?? null,
              sourceUrl: doc.sourceUrl,
              contentHash: doc.contentHash,
              contentType: doc.contentType,
            })))
          }

          return { setHash, version: row.version, changed: true }
        })
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          const winner = await db.select({ id: artifactVersions.id, version: artifactVersions.version })
            .from(artifactVersions)
            .where(identityMatch())
          const winnerRow = winner[0]
          if (winnerRow) return { setHash, version: winnerRow.version, changed: false }
          continue
        }
        throw err
      }
    }

  return null
}

/**
 * Archives the full parsed auction state, keyed on `(platform, externalId)`.
 * Called once from `refresh.ts` per crawled auction (listing-level) and again
 * from `enrich.ts` after a successful `enrichOne` (detail-level) — the second
 * call produces a new content hash whenever detail data (description,
 * attachments, source* fields, ...) was added, so both the listing snapshot
 * and the enriched snapshot end up in the archive. Persistence failures
 * propagate.
 */
export async function archiveAuction(auction: Auction, capturedAt: string): Promise<void> {
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
}
