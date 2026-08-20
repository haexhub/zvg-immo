// Serving cache, external enrichment, LLM batch bookkeeping and small
// operational tables. All server-internal: RLS is enabled on every one of
// them with no policies (default-deny for PostgREST's anon/authenticated
// roles) — the backend connects as table owner and bypasses RLS regardless.
import { sql } from 'drizzle-orm'
import {
  bigserial,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { auctions } from './core'

// When each crawl scope last completed successfully. Replaces list_cache,
// which stored an entire CrawlResult as one JSONB blob per region even though
// only its `fetched_at` was still read (the structured auctions /
// auction_details / auction_fetch_state tables took over serving in WP-0).
//
// Keyed per platform, not just per region: crawlSingle merges every platform
// covering a region and returns the survivors when some of them fail
// (Promise.allSettled, server/crawlers/registry.ts). A region-level timestamp
// would therefore claim success for a platform that never delivered, and the
// staleness filter below would read that platform's whole catalog as
// "disappeared" and hide it from search.
//
// `region` is the platform's region CODE ('sn'), matching auctions.crawl_region
// — deliberately not auctions.region, which holds the display NAME
// ('Sachsen') and cannot be joined against a crawl scope.
export const crawlState = pgTable('crawl_state', {
  country: text('country').notNull(),
  region: text('region').notNull(),
  platform: text('platform').notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }).notNull(),
  auctionCount: integer('auction_count').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.country, table.region, table.platform] }),
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
  // Snapshot of the LlmConfig actually used at *submit* time — nullable
  // because rows written before this column existed don't have it. Read back
  // at poll/merge time (llm-batch-poll.ts) instead of the poll-time config,
  // which can point at a different model by the time a batch (up to 48h)
  // completes.
  provider: text('provider'),
  model: text('model'),
  profileId: text('profile_id'),
}).enableRLS()

// Append-only log of actually-answered LLM calls (sync or one batch-job
// item each), for cost/token accounting — distinct from llmBatchJobs above,
// which only tracks job lifecycle. No FK to auctions: this must survive an
// auction later being pruned from the serving table (see
// server/utils/auction-current.ts), unlike locationEnrichment's cascade.
export const llmUsageEvents = pgTable('llm_usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  task: text('task').notNull(),
  executionMode: text('execution_mode').notNull(),
  source: text('source'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  profileId: text('profile_id'),
  platform: text('platform'),
  externalId: text('external_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  // Estimated from a static pricing table at write time — null when the
  // model isn't in it, never guessed/rounded to 0 (see llm-pricing.ts).
  costUsd: doublePrecision('cost_usd'),
  // A call is logged even when the provider rejects it or returns an
  // unusable answer.  This makes cost reporting auditable instead of hiding
  // the failed calls which are often the reason a retry loop is expensive.
  status: text('status').notNull().default('succeeded'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  // Set only for a batch-job item (see llm-batch-poll.ts), null for sync
  // calls. Together with platform/externalId this is that item's stable
  // result identity — the unique index below lets recordLlmUsage no-op a
  // retry-after-partial-failure instead of double-counting the same call.
  batchJobName: text('batch_job_name'),
}, (table) => [
  index('idx_llm_usage_events_occurred_at').on(table.occurredAt.desc()),
  index('idx_llm_usage_events_task_occurred').on(table.task, table.occurredAt.desc()),
  uniqueIndex('idx_llm_usage_events_batch_identity')
    .on(table.batchJobName, table.platform, table.externalId)
    .where(sql`${table.batchJobName} is not null`),
]).enableRLS()

// Generic key/value store for admin-configurable dashboard settings without
// a redeploy (server/utils/app-settings.ts).
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

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
