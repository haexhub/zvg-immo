// Auction identity, the versioned raw-archive (artifact_*) and the versioned
// extraction result (auction_details) — all in one file because their
// foreign keys form a genuine cycle across tables: auction_details
// references both `auctions` and `artifact_versions`, while
// artifact_captures/artifact_versions reference `auctions` back. Splitting
// this across files would need identity.ts to import archive.ts and vice
// versa; keeping them together avoids that and mirrors how schema.sql itself
// sequences these CREATE TABLEs (auctions before artifacts before details,
// so every FK's parent already exists).
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Stable master identity. Object, price and extraction fields live only in
// the immutable auction_details versions below; mutable crawl/pipeline state
// lives in auction_fetch_state.
//
// lat/lng live HERE, not on auction_details (WP-0 decision): a position is
// identity, not an extraction result. Under the old, auction_details-scoped
// placement, a new extraction version that didn't carry coordinates forward
// silently reset geocoding coverage to zero for that auction — the
// suspected root cause of the 1% coverage measured on prod (see
// docs/plans/2026-08-04-gis-wp0-schema-neuaufbau.md).
export const auctions = pgTable('auctions', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  country: text('country').notNull(),
  region: text('region').notNull(),
  authority: text('authority').notNull(),
  caseNumber: text('case_number').notNull(),
  title: text('title'),
  auctionDateIso: timestamp('auction_date_iso', { withTimezone: true }),
  auctionDateText: text('auction_date_text'),
  cancelled: boolean('cancelled').notNull(),
  lat: numeric('lat'),
  lng: numeric('lng'),
  // Geocoding observability (WP-3): distinguishes "never attempted" (all
  // three NULL) from "attempted, still unresolved" — a backfill can't tell
  // those apart from lat/lng alone, and would otherwise either skip
  // addresses it never actually tried or hammer ones already known
  // unresolvable. geocodeProvider records which backend ran the attempt
  // (nominatim vs locationiq) so a provider switch doesn't get masked by
  // stale failures from the previous one — see
  // docs/plans/2026-08-04-gis-wp3-geocoding-abdeckung.md.
  geocodeAttemptedAt: timestamp('geocode_attempted_at', { withTimezone: true }),
  geocodeResult: text('geocode_result'), // 'geocoded' | 'unresolvable' | 'pending'
  geocodeProvider: text('geocode_provider'), // 'nominatim' | 'locationiq'
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // Last crawl that still returned this auction, and the crawl scope it was
  // returned under. Together with crawl_state (ops.ts) these are what lets an
  // auction expire: a listing that stops appearing has no other signal — the
  // portals publish no "sold"/"withdrawn" flag, and roughly a quarter of the
  // registered platforms (agi, bima, dga-ag, gb, kip, lt, pt, us) never carry
  // an auction date to expire against either.
  //
  // crawlRegion is the platform's region CODE ('sn'), not the display name in
  // `region` above ('Sachsen') — only the code identifies a crawl scope. It
  // stays NULL until this auction's next crawl, which makes the staleness
  // filter a no-op for not-yet-recrawled rows rather than hiding them.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  crawlRegion: text('crawl_region'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId] }),
  index('idx_auctions_country_region').on(table.country, table.region),
  // Covers the staleness join in buildAuctionSearchFilter / data-api-auction.
  index('idx_auctions_crawl_scope').on(table.country, table.crawlRegion, table.platform),
]).enableRLS()

// A directed, canonical (left < right) edge between two independently stored
// source auctions. This deliberately is not a merge: both auctions retain
// their own court data, source URLs and document sets. `source` reserves room
// for a later admin confirmation without mixing it with computed edges.
export const auctionRelationships = pgTable('auction_relationships', {
  leftPlatform: text('left_platform').notNull(),
  leftExternalId: text('left_external_id').notNull(),
  rightPlatform: text('right_platform').notNull(),
  rightExternalId: text('right_external_id').notNull(),
  kind: text('kind').notNull(), // 'same_proceeding' | 'same_address'
  confidence: text('confidence').notNull(), // 'high' | 'medium'
  source: text('source').notNull().default('auto'), // 'auto' | 'manual'
  evidence: jsonb('evidence').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.leftPlatform, table.leftExternalId, table.rightPlatform, table.rightExternalId] }),
  index('idx_auction_relationships_left').on(table.leftPlatform, table.leftExternalId),
  index('idx_auction_relationships_right').on(table.rightPlatform, table.rightExternalId),
  foreignKey({
    name: 'fk_auction_relationships_left_auction',
    columns: [table.leftPlatform, table.leftExternalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'fk_auction_relationships_right_auction',
    columns: [table.rightPlatform, table.rightExternalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()

// G1 Roh-Archiv Schicht 1. artifact_blobs = deduplicated bytes (S3 key =
// content_hash, sha256).
export const artifactBlobs = pgTable('artifact_blobs', {
  contentHash: text('content_hash').primaryKey(),
  s3Key: text('s3_key').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
}).enableRLS()

// Deduplicated capture index. country/region/authority/case_number were
// dropped in favor of joining `auctions` once the identity redesign
// guaranteed that row always exists before any capture is written.
export const artifactCaptures = pgTable('artifact_captures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  kind: text('kind').notNull(), // 'auction' | 'document' | 'detail_html' | 'document_text' | 'photo'
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  contentHash: text('content_hash').notNull().references(() => artifactBlobs.contentHash),
  sourceUrl: text('source_url'),
}, (table) => [
  index('idx_capt_identity_time').on(table.platform, table.externalId, table.capturedAt.desc()),
  index('idx_capt_hash').on(table.contentHash),
  // Append-only per real content change for 'auction' rows.
  uniqueIndex('idx_capt_unique_auction_hash')
    .on(table.kind, table.platform, table.externalId, table.contentHash)
    .where(sql`${table.kind} = 'auction'`),
  // One row per identity+source_url+bytes for everything else, so an
  // updated document stays addressable by older document-set versions
  // without re-adding duplicates on every recrawl.
  uniqueIndex('idx_capt_unique_source_hash')
    .on(table.kind, table.platform, table.externalId, sql`(coalesce(${table.sourceUrl}, ''))`, table.contentHash)
    .where(sql`${table.kind} <> 'auction'`),
  foreignKey({
    name: 'fk_artifact_captures_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()

// Versioned "these documents were seen together" manifest per auction.
// uqArtifactVersionsIdentity is the anchor auction_details' composite FK
// below needs — it guarantees an extraction version can only reference a
// manifest belonging to its own auction, not a foreign one.
export const artifactVersions = pgTable('artifact_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  setHash: text('set_hash').notNull(),
  version: integer('version').notNull(),
  documentCount: integer('document_count').notNull(),
}, (table) => [
  unique('artifact_versions_platform_external_id_set_hash_key').on(table.platform, table.externalId, table.setHash),
  unique('artifact_versions_platform_external_id_version_key').on(table.platform, table.externalId, table.version),
  unique('uq_artifact_versions_identity').on(table.id, table.platform, table.externalId),
  index('idx_doc_sets_identity_version').on(table.platform, table.externalId, table.version.desc()),
  foreignKey({
    name: 'fk_artifact_versions_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()

export const artifactVersionItems = pgTable('artifact_version_items', {
  setId: bigint('set_id', { mode: 'number' }).notNull().references(() => artifactVersions.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  kind: text('kind').notNull(),
  label: text('label'),
  filename: text('filename'),
  fileId: text('file_id'),
  sourceUrl: text('source_url').notNull(),
  contentHash: text('content_hash').notNull(),
  contentType: text('content_type').notNull(),
}, (table) => [
  primaryKey({ columns: [table.setId, table.ordinal] }),
  index('idx_doc_set_items_hash').on(table.contentHash),
  // Explicit short name: Drizzle's auto-generated name for this FK
  // (artifact_version_items_content_hash_artifact_blobs_content_hash_fk)
  // exceeds Postgres's 63-byte identifier limit and would be silently
  // truncated.
  foreignKey({
    name: 'fk_artifact_version_items_blob',
    columns: [table.contentHash],
    foreignColumns: [artifactBlobs.contentHash],
  }),
]).enableRLS()

// Typed, versioned detail/extraction state. Every changed write appends a
// version; there is no UPDATE — the version sequence IS the history.
//
// isLatest (WP-0) + the partial unique index below let a read join straight
// to "the current version" via an index lookup instead of the
// `ORDER BY version DESC LIMIT 1` LATERAL join every search query paid for
// before (see docs/plans/2026-08-04-gis-scaling-architecture.md). The write
// path (server/utils/auction-details.ts) is responsible for flipping the
// previous latest row to false in the same transaction before inserting the
// new one — the unique index only catches a violation of that invariant, it
// does not maintain it.
export const auctionDetails = pgTable('auction_details', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  version: integer('version').notNull(),
  // NULL = listing/rules-only, no documents parsed for this version.
  artifactVersionId: bigint('artifact_version_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Factual extraction timestamp (AuctionExtraction.at) — distinct from
  // createdAt because a replay can produce a different value for either.
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull(),
  address: text('address'),
  description: text('description'),
  propertyType: text('property_type'),
  landAreaSqm: numeric('land_area_sqm'),
  livingAreaSqm: numeric('living_area_sqm'),
  rooms: numeric('rooms'),
  bedrooms: numeric('bedrooms'),
  bathrooms: numeric('bathrooms'),
  floor: text('floor'),
  bathroomHasTub: boolean('bathroom_has_tub'),
  bathroomHasShower: boolean('bathroom_has_shower'),
  heating: text('heating'),
  units: integer('units'),
  yearBuilt: integer('year_built'),
  lastRenovationYear: integer('last_renovation_year'),
  marketValue: numeric('market_value'),
  currency: text('currency'),
  marketValueEur: numeric('market_value_eur'),
  condition: jsonb('condition'),
  features: text('features').array(),
  insights: jsonb('insights'),
  planningNotes: jsonb('planning_notes'),
  renovationNotes: text('renovation_notes'),
  startingBid: numeric('starting_bid'),
  currentBid: numeric('current_bid'),
  sourceSecurityDeposit: numeric('source_security_deposit'),
  securityDeposit: numeric('security_deposit'),
  biddingNotes: text('bidding_notes'),
  photoCount: integer('photo_count').notNull().default(0),
  thumbnailUrl: text('thumbnail_url'),
  extractionSource: text('extraction_source'),
  extractionConfidence: text('extraction_confidence'),
  llmAnalyzedAt: timestamp('llm_analyzed_at', { withTimezone: true }),
  documentSummary: text('document_summary'),
  extractionTexts: jsonb('extraction_texts'),
  sourceLivingAreaSqm: numeric('source_living_area_sqm'),
  sourceLandAreaSqm: numeric('source_land_area_sqm'),
  sourceRooms: numeric('source_rooms'),
  marketValueText: text('market_value_text'),
  isLatest: boolean('is_latest').notNull().default(true),
  // Admin-triggered single-model comparison run (docs/plans/2026-08-08-
  // admin-auktions-technikseite.md, WP-0): a trial version never sets
  // isLatest and never demotes the current live row — writeAuctionDetails
  // is the only place that enforces this. Promoting one to live is a
  // separate, explicit action (WP-5), not handled here.
  isTrial: boolean('is_trial').notNull().default(false),
  // Provenance (WP-1) — deliberately outside VALUE_COLUMNS in
  // auction-details.ts: a model swap alone must not mint a version when the
  // extracted facts are identical. NULL for rows written by enrich.ts/
  // geocode.ts/llm-batch-poll.ts, which don't pass these yet.
  llmProvider: text('llm_provider'),
  llmModel: text('llm_model'),
  // References app_settings-stored LlmProviderProfile.id (a string, not a
  // DB row) — no FK, profiles aren't a table.
  llmProfileId: text('llm_profile_id'),
  runTrigger: text('run_trigger'),
  llmDurationMs: integer('llm_duration_ms'),
  // Same provenance rationale as llmDurationMs above — resolved the same way
  // llm_usage_events does (provider-reported amount, falling back to the
  // static price table), so the admin technical page can show per-version
  // cost without a fragile runtime join against that separate log.
  llmCostUsd: doublePrecision('llm_cost_usd'),
  // Same provenance rationale as llmCostUsd above.
  llmInputTokens: integer('llm_input_tokens'),
  llmOutputTokens: integer('llm_output_tokens'),
}, (table) => [
  unique('auction_details_platform_external_id_version_key').on(table.platform, table.externalId, table.version),
  index('idx_auction_details_identity_version').on(table.platform, table.externalId, table.version.desc()),
  index('idx_auction_details_property_type').on(table.propertyType),
  index('idx_auction_details_living_area').on(table.livingAreaSqm),
  index('idx_auction_details_land_area').on(table.landAreaSqm),
  index('idx_auction_details_year_built').on(table.yearBuilt),
  uniqueIndex('idx_auction_details_latest').on(table.platform, table.externalId).where(sql`${table.isLatest}`),
  // Both FKs below use an explicit short name: Drizzle's auto-generated
  // names for these composite FKs exceed Postgres's 63-byte identifier
  // limit and would be silently truncated (risking a collision between the
  // two).
  foreignKey({
    name: 'fk_auction_details_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
  // Composite, not a plain references(artifactVersions.id): prevents a row
  // from pointing at a manifest belonging to a DIFFERENT auction. NULL stays
  // allowed (MATCH SIMPLE doesn't check an FK with a null column) — deleting
  // a country's raw archive (deleteRawArchiveCountry()) cascades through
  // artifact_versions -> auction_details on purpose, taking the derived
  // extraction history with it rather than failing on this FK.
  foreignKey({
    name: 'fk_auction_details_artifact_version',
    columns: [table.artifactVersionId, table.platform, table.externalId],
    foreignColumns: [artifactVersions.id, artifactVersions.platform, artifactVersions.externalId],
  }).onDelete('cascade'),
]).enableRLS()

// Curated photos are extraction output, versioned through auction_details.
// The actual files live in the image bucket; artifact_blobs is the document
// archive and deliberately has no FK relationship to this table.
export const auctionPhotos = pgTable('auction_photos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  auctionDetailsId: bigint('auction_details_id', { mode: 'number' }).notNull().references(() => auctionDetails.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  file: text('file').notNull(),
  category: text('category').notNull(),
  caption: text('caption'),
  isPropertyPhoto: boolean('is_property_photo').notNull(),
  appealScore: integer('appeal_score'),
}, (table) => [
  unique('auction_photos_auction_details_id_ordinal_key').on(table.auctionDetailsId, table.ordinal),
  index('idx_auction_photos_details').on(table.auctionDetailsId, table.ordinal),
]).enableRLS()

// Mutable crawl/pipeline state. Two independent writers own disjoint column
// groups; each only updates its own group so concurrent crawl/photo/LLM work
// cannot reset the other's values.
//
// llmArtifactVersionId's FK to artifact_versions is NOT declared here: it
// needs `ON DELETE SET NULL` on only that one column of a 3-column composite
// FK (platform/external_id stay NOT NULL and must not be nulled), which
// Drizzle's foreignKey() builder cannot express — see the hand-written
// constraint in the RLS/constraints migration.
export const auctionFetchState = pgTable('auction_fetch_state', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  pdfUrl: text('pdf_url'),
  pdfUrlUpstream: text('pdf_url_upstream'),
  detailUrl: text('detail_url'),
  detailUrlUpstream: text('detail_url_upstream'),
  attachments: jsonb('attachments').notNull().default([]),
  photoUrls: text('photo_urls').array(),
  sourceUpdatedIso: timestamp('source_updated_iso', { withTimezone: true }),
  detailFetchedAt: timestamp('detail_fetched_at', { withTimezone: true }),
  enrichClaimedAt: timestamp('enrich_claimed_at', { withTimezone: true }),
  llmBatchJob: text('llm_batch_job'),
  llmArtifactVersionId: bigint('llm_artifact_version_id', { mode: 'number' }),
  llmFailures: integer('llm_failures').notNull().default(0),
  llmLastAttemptedAt: timestamp('llm_last_attempted_at', { withTimezone: true }),
  llmClaimedAt: timestamp('llm_claimed_at', { withTimezone: true }),
  photosCheckedAt: timestamp('photos_checked_at', { withTimezone: true }),
  photoFailures: integer('photo_failures').notNull().default(0),
  photoLastAttemptedAt: timestamp('photo_last_attempted_at', { withTimezone: true }),
  photoPipelineVersion: integer('photo_pipeline_version'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId] }),
  index('idx_auction_fetch_state_llm_batch_job').on(table.llmBatchJob).where(sql`${table.llmBatchJob} IS NOT NULL`),
  // Explicit short name: Drizzle's auto-generated name for this FK exceeds
  // Postgres's 63-byte identifier limit and would be silently truncated.
  foreignKey({
    name: 'fk_auction_fetch_state_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()
