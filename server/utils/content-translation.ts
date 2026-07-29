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

export interface AuctionTranslationRow extends ContentTranslationRow {
  contentHash: string
  status: 'pending' | 'completed' | 'failed'
  errorMessage: string | null
}

export async function readAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
): Promise<AuctionTranslationRow | null> {
  const { rows } = await db.query<AuctionTranslationRow>(
    `SELECT
       content_hash AS "contentHash",
       status,
       title,
       description,
       document_summary AS "documentSummary",
       extraction_texts AS "extractionTexts",
       error_message AS "errorMessage"
     FROM auction_translations
     WHERE platform = $1 AND external_id = $2 AND lang = $3`,
    [platform, externalId, lang],
  )
  return rows[0] ?? null
}

/** Atomically reserves the only translation attempt for an auction/language. */
export async function claimAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
  contentHash: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO auction_translations
       (platform, external_id, lang, content_hash, status, started_at)
     VALUES ($1, $2, $3, $4, 'pending', now())
     ON CONFLICT (platform, external_id, lang) DO NOTHING`,
    [platform, externalId, lang, contentHash],
  )
  return rowCount === 1
}

export async function completeAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  lang: string,
  value: ContentTranslationRow,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE auction_translations SET
       status = 'completed',
       title = $4,
       description = $5,
       document_summary = $6,
       extraction_texts = $7,
       error_message = null,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND lang = $3 AND status = 'pending'`,
    [
      platform,
      externalId,
      lang,
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
  errorMessage: string,
): Promise<void> {
  await db.query(
    `UPDATE auction_translations SET
       status = 'failed',
       error_message = $4,
       completed_at = now()
     WHERE platform = $1 AND external_id = $2 AND lang = $3 AND status = 'pending'`,
    [platform, externalId, lang, errorMessage.slice(0, 4000)],
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
