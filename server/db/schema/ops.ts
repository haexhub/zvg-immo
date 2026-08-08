// Serving cache, external enrichment, LLM batch bookkeeping and small
// operational tables. All server-internal: RLS is enabled on every one of
// them with no policies (default-deny for PostgREST's anon/authenticated
// roles) — the backend connects as table owner and bypasses RLS regardless.
import {
  bigserial,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { auctions } from './core'

// Replaces the former per-region JSON cache files
// (.cache_zvg/list/<country>-<region>.json) as the serving store — one blob
// per region, written by refresh.ts on its existing per-portal cadence.
export const listCache = pgTable('list_cache', {
  country: text('country').notNull(),
  region: text('region').notNull(),
  result: jsonb('result').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.country, table.region] }),
]).enableRLS()

// External market/hazard enrichment, stored separately from the LLM
// extraction result: provider licenses, TTLs and source versions have their
// own cadence, and detail pages only ever read the cached result.
export const locationEnrichment = pgTable('location_enrichment', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  enrichment: jsonb('enrichment').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId] }),
  index('idx_location_enrichment_checked_at').on(table.checkedAt.desc()),
  foreignKey({
    name: 'fk_location_enrichment_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()

// Tracks in-flight LLM Batch API jobs submitted by enrich.ts/reprocess.ts.
// Gemini echoes the submitted `key` directly in its result JSONL; Anthropic
// restricts custom_id to a short safe alphabet, so customIdMap stores
// `{ custom_id: "platform:externalId" }` for those jobs.
export const llmBatchJobs = pgTable('llm_batch_jobs', {
  jobName: text('job_name').primaryKey(),
  source: text('source').notNull(),
  status: text('status').notNull().default('pending'),
  itemCount: integer('item_count').notNull(),
  customIdMap: jsonb('custom_id_map').notNull().default({}),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Reason a job resolved as 'failed'/'expired' (poll-time, from the
  // provider's own error field).
  errorMessage: text('error_message'),
}).enableRLS()

// Generic key/value store for admin-configurable dashboard settings without
// a redeploy (server/utils/app-settings.ts).
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

// Generic cache for on-demand LLM insight cards (Nutzungsideen, Sanierungskosten,
// ...). One table for every future insight instead of one table per feature.
// Immutable per (insight_id, content_hash), same contract as content_translations.
export const auctionInsights = pgTable('auction_insights', {
  insightId: text('insight_id').notNull(),
  contentHash: text('content_hash').notNull(),
  payload: jsonb('payload').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.insightId, table.contentHash] }),
]).enableRLS()

// Per-item error history for tracked tasks (enrich/reprocess/...), distinct
// from task_run_status's single lastWarning/lastError string (app_settings).
// Rows age out on write (server/utils/task-run-errors.ts) instead of a fixed
// row cap.
export const taskRunErrors = pgTable('task_run_errors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  task: text('task').notNull(),
  platform: text('platform'),
  externalId: text('external_id'),
  category: text('category').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_task_run_errors_task_created').on(table.task, table.createdAt.desc()),
  index('idx_task_run_errors_platform_external_created').on(table.platform, table.externalId, table.createdAt.desc()),
]).enableRLS()
