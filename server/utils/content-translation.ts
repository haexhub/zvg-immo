// Postgres-backed cache for LLM-translated auction title/description, the
// pre-generated synthesis of its documents and structured extraction free text.
// (content_translations table, WP-8). Immutable per (content_hash, lang) —
// once written, an entry is never updated, so a concurrent duplicate insert
// (two requests racing on the same cache miss) is a harmless no-op.
//
// The auction-level gate below is keyed per auction_details version, not per
// auction: a new extraction version can change title/description, and the
// translation of an older version stays retrievable as history rather than
// being overwritten.

import type { Pool } from 'pg'

import type { TranslatableExtractionTexts } from '~/lib/extraction-translation'

export interface ContentTranslationRow {
  title: string | null
  address: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
}

// A crashed/redeployed instance can leave a `pending` row behind. Without a
// lease that row would 409 every later request forever, so another request may
// take the claim over once it is this old.
/** Keep status-driven retries aligned with the atomic takeover gate below. */
export const AUCTION_TRANSLATION_CLAIM_LEASE = '10 minutes'
export const AUCTION_TRANSLATION_CLAIM_LEASE_MS = 10 * 60 * 1000
// A failed attempt is remembered and served as the error for this long, then a
// retry is allowed. A provider rate limit or outage must not lock an auction
// out of ever getting a translation — the same lockout that PR #200 had to undo
// for extraction (see server/tasks/reprocess.ts's isRateLimitError handling).
// translation.post.ts additionally bypasses this window immediately when the
// resolved LLM config no longer matches `failedConfig` below — a /settings
// provider/model switch shouldn't have to wait out a stale config's backoff.
const RETRY_AFTER = '1 hour'

export interface AuctionTranslationRow extends ContentTranslationRow {
  contentHash: string
  status: 'pending' | 'completed' | 'failed'
  errorMessage: string | null
  /** Fingerprint of the LLM config that produced `errorMessage` on a
   *  `failed` row — lets the caller bypass `retryDue`'s time-based backoff
   *  immediately once the currently-resolved config no longer matches. */
  failedConfig: string | null
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
  version: number,
  lang: string,
): Promise<AuctionTranslationRow | null> {
  // The age comparisons run in Postgres so all app instances share one clock.
  const { rows } = await db.query<AuctionTranslationRow>(
    `SELECT
       content_hash AS "contentHash",
       status,
       title,
       address,
       description,
       document_summary AS "documentSummary",
       extraction_texts AS "extractionTexts",
       error_message AS "errorMessage",
       failed_config AS "failedConfig",
       started_at < now() - $5::interval AS "claimStale",
       coalesce(completed_at, started_at) < now() - $6::interval AS "retryDue"
     FROM auction_translations
     WHERE platform = $1 AND external_id = $2 AND version = $3 AND lang = $4`,
    [platform, externalId, version, lang, AUCTION_TRANSLATION_CLAIM_LEASE, RETRY_AFTER],
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
  version: number,
  lang: string,
  contentHash: string,
): Promise<AuctionTranslationClaim | null> {
  // started_at is truncated to millisecond precision: node-postgres reads
  // timestamptz columns into a JS Date, which cannot hold more than
  // millisecond precision, so a raw now() value (microsecond precision)
  // round-tripped through `claim.startedAt` never matches its own row again
  // in completeAuctionTranslation/failAuctionTranslation's `started_at = $4`
  // — every claim leaked as permanently 'pending'.
  const { rows } = await db.query<AuctionTranslationClaim>(
    `INSERT INTO auction_translations
       (platform, external_id, version, lang, content_hash, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', date_trunc('milliseconds', now()))
     ON CONFLICT (platform, external_id, version, lang) DO UPDATE SET
       content_hash = excluded.content_hash,
       status = 'pending',
       started_at = date_trunc('milliseconds', now()),
       completed_at = null,
       title = null,
       address = null,
       description = null,
       document_summary = null,
       extraction_texts = null,
       error_message = null,
       failed_config = null
     WHERE auction_translations.status = 'failed'
        OR (auction_translations.status = 'pending'
            AND auction_translations.started_at < now() - $6::interval)
        OR (auction_translations.status = 'completed'
            AND auction_translations.content_hash <> excluded.content_hash)
     RETURNING started_at AS "startedAt"`,
    [platform, externalId, version, lang, contentHash, AUCTION_TRANSLATION_CLAIM_LEASE],
  )
  return rows[0] ?? null
}

export async function completeAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  version: number,
  lang: string,
  claim: AuctionTranslationClaim,
  value: ContentTranslationRow,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE auction_translations SET
       status = 'completed',
       title = $6,
       address = $7,
       description = $8,
       document_summary = $9,
       extraction_texts = $10,
       error_message = null,
       failed_config = null,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND version = $3 AND lang = $4
       AND status = 'pending' AND started_at = $5`,
    [
      platform,
      externalId,
      version,
      lang,
      claim.startedAt,
      value.title,
      value.address,
      value.description,
      value.documentSummary,
      value.extractionTexts == null ? null : JSON.stringify(value.extractionTexts),
    ],
  )
  if (rowCount !== 1) {
    throw new Error(`translation claim lost for ${platform}/${externalId}@${version}/${lang}`)
  }
}

export async function failAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  version: number,
  lang: string,
  claim: AuctionTranslationClaim,
  errorMessage: string,
  configFingerprint: string | null,
): Promise<void> {
  // Scoped to our own claim: a slow attempt whose lease already expired must
  // not mark the newer attempt's row as failed.
  await db.query(
    `UPDATE auction_translations SET
       status = 'failed',
       error_message = $6,
       failed_config = $7,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND version = $3 AND lang = $4
       AND status = 'pending' AND started_at = $5`,
    [platform, externalId, version, lang, claim.startedAt, errorMessage.slice(0, 4000), configFingerprint],
  )
}

export async function readContentTranslation(
  db: Pool,
  contentHash: string,
  lang: string,
): Promise<ContentTranslationRow | null> {
  const { rows } = await db.query<ContentTranslationRow>(
    `SELECT title, address, description, document_summary AS "documentSummary", extraction_texts AS "extractionTexts"
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
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: TranslatableExtractionTexts | null,
): Promise<void> {
  await db.query(
    `INSERT INTO content_translations (content_hash, lang, title, address, description, document_summary, extraction_texts, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (content_hash, lang) DO NOTHING`,
    [contentHash, lang, title, address, description, documentSummary, extractionTexts == null ? null : JSON.stringify(extractionTexts)],
  )
}
