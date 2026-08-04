// Phase 2/3/5: saved searches, watchlist, alert subscriptions and the
// self-service Daten-API keys. All are owned by a `auth.users` row (GoTrue,
// migrated by the `auth` service in docker-compose.yml — Drizzle must never
// create or alter that schema, see the note on userId below).
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  date,
  foreignKey,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

// `auth.users(id)` on purpose is a *plain* uuid column, not a Drizzle
// `.references()`: `auth` is Supabase/GoTrue's schema, not ours, and
// declaring a Drizzle table for it would make `drizzle-kit generate` emit
// `CREATE SCHEMA "auth"` / `CREATE TABLE "auth"."users"` — both already exist
// and would break the migration. The real FK to auth.users(id) is added by
// the hand-written RLS/constraints migration (see drizzle/ 0002_*).

export const savedSearches = pgTable('saved_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  // Mirrors the query-param names lib/auction-filters.ts / pages/search.vue
  // read and write (authority/category/cancelled, not court/kat/aufgehoben).
  filters: jsonb('filters').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  pgPolicy('own_rows', {
    for: 'all',
    using: sql`${table.userId} = auth.uid()`,
    withCheck: sql`${table.userId} = auth.uid()`,
  }),
]).enableRLS()

export const watchlistItems = pgTable('watchlist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  authority: text('authority'),
  caseNumber: text('case_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('watchlist_items_user_id_platform_external_id_key').on(table.userId, table.platform, table.externalId),
  pgPolicy('own_rows', {
    for: 'all',
    using: sql`${table.userId} = auth.uid()`,
    withCheck: sql`${table.userId} = auth.uid()`,
  }),
]).enableRLS()

export const alertSubscriptions = pgTable('alert_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  savedSearchId: uuid('saved_search_id').notNull().references(() => savedSearches.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('alert_subscriptions_saved_search_id_key').on(table.savedSearchId),
  pgPolicy('own_rows', {
    for: 'all',
    using: sql`${table.userId} = auth.uid()`,
    withCheck: sql`${table.userId} = auth.uid()`,
  }),
]).enableRLS()

// Dedup ledger for the alert matcher (server/utils/alert-matching.ts) —
// server-internal, RLS enabled with no policies (default-deny for
// PostgREST's anon/authenticated; the backend connects as table owner and
// bypasses RLS regardless).
export const notifiedMatches = pgTable('notified_matches', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  alertSubscriptionId: uuid('alert_subscription_id').notNull(),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('notified_matches_alert_subscription_id_platform_external_id_key')
    .on(table.alertSubscriptionId, table.platform, table.externalId),
  // Explicit short name: Drizzle's auto-generated name for this FK exceeds
  // Postgres's 63-byte identifier limit and would be silently truncated.
  foreignKey({
    name: 'fk_notified_matches_alert_subscription',
    columns: [table.alertSubscriptionId],
    foreignColumns: [alertSubscriptions.id],
  }).onDelete('cascade'),
]).enableRLS()

// Self-service Daten-API keys (server/utils/api-key.ts). Only a SHA-256 hash
// is stored; plaintext keys never reach the database.
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  label: text('label').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  pgPolicy('own_rows', {
    for: 'all',
    using: sql`${table.userId} = auth.uid()`,
    withCheck: sql`${table.userId} = auth.uid()`,
  }),
]).enableRLS()

// Per-day request counter per key (server/middleware/data-api-auth.ts).
export const apiUsage = pgTable('api_usage', {
  apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  count: bigint('count', { mode: 'number' }).notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.apiKeyId, table.day] }),
]).enableRLS()
