// Phase 3: append-only auction history for Grafana + analyses. refresh
// writes the listing-level state, enrich writes the final detail-decorated
// state (server/utils/history.ts). Deliberately denormalized (no FK to
// auctions) and append-only — this table, together with artifact_captures
// and auction_snapshot, is the time-series data a schema reset cannot
// recreate from a fresh crawl (see the WP-0 plan's "Datenverlust" section).
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

export const auctionObservations = pgTable('auction_observations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  platform: text('platform').notNull(),
  country: text('country').notNull(),
  region: text('region').notNull(),
  externalId: text('external_id').notNull(),
  authority: text('authority').notNull(),
  caseNumber: text('case_number').notNull(),
  title: text('title'),
  propertyType: text('property_type'),
  landAreaSqm: numeric('land_area_sqm'),
  livingAreaSqm: numeric('living_area_sqm'),
  rooms: numeric('rooms'),
  units: integer('units'),
  marketValueEur: numeric('market_value_eur'),
  // WP-2: native value + ISO-4217 currency (source of truth); market_value_eur
  // is derived from these (deriveMarketValueEur, server/utils/exchange-rate.ts).
  marketValue: numeric('market_value'),
  currency: text('currency'),
  auctionDateIso: timestamp('auction_date_iso', { withTimezone: true }),
  cancelled: boolean('cancelled').notNull(),
  // Complete parsed source record for every observation, so new fields can
  // be analysed historically without having to predict them here.
  payload: jsonb('payload'),
}, (table) => [
  index('idx_obs_country_region_time').on(table.country, table.region, table.capturedAt.desc()),
  index('idx_obs_platform_zvgid_time').on(table.platform, table.externalId, table.capturedAt.desc()),
  index('idx_obs_az_time').on(table.authority, table.caseNumber, table.capturedAt.desc()),
]).enableRLS()

// One row per auction and observation kind ('list' from refresh/rebuild,
// 'detail' from enrich): the content hash and time of the last observation
// written for it. recordObservations compares against it to skip unchanged
// payloads, a primary-key lookup instead of a scan of the auction's history.
export const auctionObservationHeads = pgTable('auction_observation_heads', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  kind: text('kind').notNull(),
  payloadHash: text('payload_hash').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId, table.kind] }),
]).enableRLS()
