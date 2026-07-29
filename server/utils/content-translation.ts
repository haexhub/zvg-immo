// Postgres-backed cache for LLM-translated auction title/description, the
// pre-generated synthesis of its documents and structured extraction free text.
// (content_translations table, WP-8). Immutable per (content_hash, lang) —
// once written, an entry is never updated, so a concurrent duplicate insert
// (two requests racing on the same cache miss) is a harmless no-op.

import type { Pool } from 'pg'

import type { TranslatableExtractionTexts } from '~/lib/extraction-translation'

export interface ContentTranslationRow {
  title: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
}

// A crashed/redeployed instance can leave a `pending` row behind. Without a
// lease that row would 409 every later request forever, so another request may
// take the claim over once it is this old.
const CLAIM_LEASE = '10 minutes'
// A failed attempt is remembered and served as the error for this long, then a
// retry is allowed. A provider rate limit or outage must not lock an auction
// out of ever getting a translation — the same lockout that PR #200 had to undo
// for extraction (see server/tasks/reprocess.ts's isRateLimitError handling).
const RETRY_AFTER = '1 hour'

export interface AuctionTranslationRow extends ContentTranslationRow {
  contentHash: string
  status: 'pending' | 'completed' | 'failed'
  errorMessage: string | null
  /** `pending` row whose lease expired — another request may claim it. */
  claimStale: boolean
  /** `failed` row old enough that a fresh attempt is allowed. */
  retryDue: boolean
}

/** Opaque ownership token returned by claimAuctionTranslation. */
export type AuctionTranslationClaim = { startedAt: Date }

export async function readAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
): Promise<AuctionTranslationRow | null> {
  // The age comparisons run in Postgres so all app instances share one clock.
  const { rows } = await db.query<AuctionTranslationRow>(
    `SELECT
       content_hash AS "contentHash",
       status,
       title,
       description,
       document_summary AS "documentSummary",
       extraction_texts AS "extractionTexts",
       error_message AS "errorMessage",
       started_at < now() - $4::interval AS "claimStale",
       coalesce(completed_at, started_at) < now() - $5::interval AS "retryDue"
     FROM auction_translations
     WHERE platform = $1 AND external_id = $2 AND lang = $3`,
    [platform, externalId, lang, CLAIM_LEASE, RETRY_AFTER],
  )
  return rows[0] ?? null
}

/**
 * Atomically reserves the translation attempt for an auction/language. Takes
 * over a failed attempt or an abandoned `pending` claim; a `completed` row is
 * never re-claimed. Returns the ownership token, or null when another request
 * holds the claim.
 */
export async function claimAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
  contentHash: string,
): Promise<AuctionTranslationClaim | null> {
  const { rows } = await db.query<AuctionTranslationClaim>(
    `INSERT INTO auction_translations
       (platform, external_id, lang, content_hash, status, started_at)
     VALUES ($1, $2, $3, $4, 'pending', now())
     ON CONFLICT (platform, external_id, lang) DO UPDATE SET
       content_hash = excluded.content_hash,
       status = 'pending',
       started_at = now(),
       completed_at = null,
       error_message = null
     WHERE auction_translations.status = 'failed'
        OR (auction_translations.status = 'pending'
            AND auction_translations.started_at < now() - $5::interval)
     RETURNING started_at AS "startedAt"`,
    [platform, externalId, lang, contentHash, CLAIM_LEASE],
  )
  return rows[0] ?? null
}

export async function completeAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
  claim: AuctionTranslationClaim,
  value: ContentTranslationRow,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE auction_translations SET
       status = 'completed',
       title = $5,
       description = $6,
       document_summary = $7,
       extraction_texts = $8,
       error_message = null,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND lang = $3
       AND status = 'pending' AND started_at = $4`,
    [
      platform,
      externalId,
      lang,
      claim.startedAt,
      value.title,
      value.description,
      value.documentSummary,
      value.extractionTexts == null ? null : JSON.stringify(value.extractionTexts),
    ],
  )
  if (rowCount !== 1) {
    throw new Error(`translation claim lost for ${platform}/${externalId}/${lang}`)
  }
}

export async function failAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
  claim: AuctionTranslationClaim,
  errorMessage: string,
): Promise<void> {
  // Scoped to our own claim: a slow attempt whose lease already expired must
  // not mark the newer attempt's row as failed.
  await db.query(
    `UPDATE auction_translations SET
       status = 'failed',
       error_message = $5,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND lang = $3
       AND status = 'pending' AND started_at = $4`,
    [platform, externalId, lang, claim.startedAt, errorMessage.slice(0, 4000)],
  )
}

export async function readContentTranslation(
  db: Pool,
  contentHash: string,
  lang: string,
): Promise<ContentTranslationRow | null> {
  const { rows } = await db.query<ContentTranslationRow>(
    `SELECT title, description, document_summary AS "documentSummary", extraction_texts AS "extractionTexts"
     FROM content_translations
     WHERE content_hash = $1 AND lang = $2`,
    [contentHash, lang],
  )
  return rows[0] ?? null
}

export async function writeContentTranslation(
  db: Pool,
  contentHash: string,
  lang: string,
  title: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: TranslatableExtractionTexts | null,
): Promise<void> {
  await db.query(
    `INSERT INTO content_translations (content_hash, lang, title, description, document_summary, extraction_texts, at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (content_hash, lang) DO NOTHING`,
    [contentHash, lang, title, description, documentSummary, extractionTexts == null ? null : JSON.stringify(extractionTexts)],
  )
}
