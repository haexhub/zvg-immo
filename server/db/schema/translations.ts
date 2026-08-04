// i18n content translation. content_translations is the content-addressed
// value store (immutable per content_hash+lang); auction_translations is the
// durable per-auction-version claim/gate that prevents a concurrent request
// or app instance from starting a second LLM translation for the same
// target. place_name_translations is a separate cache keyed by the place
// name itself, since one name (e.g. a nearby town from OSM) is shared across
// every auction near that place.
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { auctionDetails } from './core'

export const contentTranslations = pgTable('content_translations', {
  contentHash: text('content_hash').notNull(),
  lang: text('lang').notNull(),
  title: text('title'),
  description: text('description'),
  documentSummary: text('document_summary'),
  extractionTexts: jsonb('extraction_texts'),
  address: text('address'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.contentHash, table.lang] }),
]).enableRLS()

export const auctionTranslations = pgTable('auction_translations', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  lang: text('lang').notNull(),
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull(),
  title: text('title'),
  description: text('description'),
  documentSummary: text('document_summary'),
  extractionTexts: jsonb('extraction_texts'),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Fingerprint (sha256 of provider+baseUrl+model+apiKey) of the LLM config
  // that produced a 'failed' row's error — lets a /settings provider/model
  // switch bypass the retry-after-1h backoff immediately.
  failedConfig: text('failed_config'),
  address: text('address'),
  version: integer('version').notNull(),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId, table.version, table.lang] }),
  index('idx_auction_translations_status').on(table.status, table.startedAt),
  check('auction_translations_status_check', sql`${table.status} IN ('pending', 'completed', 'failed')`),
  // ON DELETE CASCADE runs two layers deep on purpose: deleting a country's
  // artifact_versions cascades to auction_details, and this FK carries that
  // cascade one layer further into translation history — see the matching
  // comment on auction_details' own FK to artifact_versions in core.ts.
  foreignKey({
    name: 'fk_auction_translations_details',
    columns: [table.platform, table.externalId, table.version],
    foreignColumns: [auctionDetails.platform, auctionDetails.externalId, auctionDetails.version],
  }).onDelete('cascade'),
]).enableRLS()

export const placeNameTranslations = pgTable('place_name_translations', {
  name: text('name').notNull(),
  lang: text('lang').notNull(),
  translated: text('translated').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.name, table.lang] }),
]).enableRLS()
