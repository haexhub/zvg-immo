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
