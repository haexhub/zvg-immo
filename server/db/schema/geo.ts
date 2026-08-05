// Geo layer. osm_local_elements is the raw import (unchanged from
// schema.sql — still EPSG:4326, since the live proximity queries in
// server/utils/osm-proximity.ts cast it to ::geography, which only accepts
// lon/lat SRIDs; re-projecting this table is WP-6's concern, tied to the OSM
// reimport that adds new tags). geo_features/auction_geo_metrics/
// climate_cells are new skeletons for WP-4/5/7 (see
// docs/plans/2026-08-04-gis-scaling-architecture.md, "Schicht 1/2/3") — first
// versions only, later WPs extend them with ADD COLUMN migrations.
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  customType,
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
} from 'drizzle-orm/pg-core'
import { auctions } from './core'

// PostGIS geometry with a fixed SRID but a mixed underlying type (points,
// lines and polygons in the same column) — Drizzle's built-in `geometry()`
// helper only models single-point columns, so this needs a small custom
// type. Treated as an opaque string at the TS level; every query against it
// stays a `sql` template (ST_DWithin, ST_Subdivide, the `<->` KNN operator),
// same as the rest of this project's raw-SQL data access.
const geometry = (srid: number) =>
  customType<{ data: string }>({
    dataType() {
      return `geometry(Geometry, ${srid})`
    },
  })

// Local OSM data (loaded out-of-band by a standalone osm2pgsql job, not by
// this app) — server/utils/external-data/osm-local.ts. Real geometry (not
// just a center point) on purpose: this table is meant to carry future
// geodata features too, without a schema change.
export const osmLocalElements = pgTable('osm_local_elements', {
  osmType: text('osm_type').notNull(),
  osmId: bigint('osm_id', { mode: 'number' }).notNull(),
  geom: geometry(4326)('geom').notNull(),
  tags: jsonb('tags').notNull(),
  country: text('country').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // country is part of the identity, not just an attribute: Geofabrik's
  // per-country extracts overlap at borders/coastlines, so the same
  // real-world element (a cross-border ferry terminal, a hiking/canoe
  // route relation with members in two countries) can legitimately appear
  // in more than one country's import with the same osm_type/osm_id. A PK
  // without country meant the second country's swap collided on that one
  // row and rolled back its entire import (observed live during the
  // 2026-08-05 WP-6 reimport: one shared ferry terminal node zeroed out
  // Sweden's whole load). Each country now keeps its own row for a shared
  // element instead of the two competing to "own" it.
  primaryKey({ columns: [table.osmType, table.osmId, table.country] }),
  index('idx_osm_local_elements_geom').using('gist', table.geom),
  index('idx_osm_local_elements_country').on(table.country),
  // Landing-page geo rails (server/api/landing/rails.get.ts) and the search
  // Umgebung filters (auction-search-filters.ts) filter with
  // `country = $1 AND tags ->> 'natural'/'waterway' = $2` inside an EXISTS
  // subquery; these composite expression indexes let that use an index scan.
  index('idx_osm_local_elements_country_natural').on(table.country, sql`(${table.tags} ->> 'natural')`),
  index('idx_osm_local_elements_country_waterway').on(table.country, sql`(${table.tags} ->> 'waterway')`),
  // Tag-only counterparts (docs/plans/2026-08-04-gis-wp1-index-notfall.md):
  // the environment/proximity filters (auction-search-filters.ts) correlate
  // `o.country = a.country` against a per-row value, not a literal, so the
  // country-prefixed indexes above can't be used as an equality seek for
  // that — these make the OR-chain's BitmapOr plan work regardless of
  // country (PR #310, measured on Germany-scale data: ~7-10s without them).
  index('idx_osm_local_elements_tag_natural').on(sql`(${table.tags} ->> 'natural')`),
  index('idx_osm_local_elements_tag_waterway').on(sql`(${table.tags} ->> 'waterway')`),
  index('idx_osm_local_elements_tag_water').on(sql`(${table.tags} ->> 'water')`),
  index('idx_osm_local_elements_tag_place').on(sql`(${table.tags} ->> 'place')`),
  index('idx_osm_local_elements_tag_aeroway').on(sql`(${table.tags} ->> 'aeroway')`),
  // Every proximity EXISTS/ST_DWithin subquery (osm-proximity.ts) casts geom
  // to ::geography — a plain GIST on geom (above) doesn't serve that
  // predicate, so this table still needs the geography-cast index until
  // WP-4/5 remove the cast entirely.
  index('idx_osm_local_elements_geog').using('gist', sql`((${table.geom})::geography)`),
]).enableRLS()

// Schicht 3 (climate_cells): 0.1° ERA5-Land raster grid. Auctions reference
// a cell via auction_geo_metrics.climateCellId instead of duplicating
// climate normals per auction — Europe has ~150k cells at 0.1°, and that
// count doesn't scale with the number of auctions. Only summerAvgTempC is
// modeled so far (the one filter named concretely in the architecture doc);
// WP-7 defines the full set of normals fetched from Open-Meteo's historical
// archive.
export const climateCells = pgTable('climate_cells', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lat: numeric('lat').notNull(),
  lon: numeric('lon').notNull(),
  summerAvgTempC: numeric('summer_avg_temp_c'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
}, (table) => [
  unique('climate_cells_lat_lon_key').on(table.lat, table.lon),
]).enableRLS()

// Schicht 1 (geo_features): normalized, query-ready POI/line/area layer
// built from osm_local_elements (no new import). `kind` replaces raw OSM tag
// matching ("sea is coastline OR beach OR bay OR ...") with a value computed
// once at build time instead of re-evaluated on every query — the OR-chain
// fragility that made the Bitmap-vs-Seq-Scan planner choice on
// osm_local_elements depend on a single valid index (see the architecture
// doc's root-cause section) has no equivalent here. Large geometries are
// expected to be pre-split with ST_Subdivide by the WP-4 build job so a
// GIST index actually excludes candidates; this table doesn't enforce that
// itself.
export const geoFeatures = pgTable('geo_features', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  name: text('name'),
  country: text('country').notNull(),
  osmType: text('osm_type'),
  osmId: bigint('osm_id', { mode: 'number' }),
  geom3035: geometry(3035)('geom_3035').notNull(),
  // Build generation this row belongs to — bumped by the WP-4 build job on a
  // full rebuild (OSM reimport), so auction_geo_metrics rows computed
  // against an older generation can be told apart from current ones and
  // recomputed instead of silently trusted (see the architecture doc's
  // "features_epoch + point_hash" invalidation note).
  featuresEpoch: integer('features_epoch').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_geo_features_geom_3035').using('gist', table.geom3035),
  index('idx_geo_features_kind').on(table.kind),
  index('idx_geo_features_kind_country').on(table.kind, table.country),
]).enableRLS()

// Schicht 2 (auction_geo_metrics): one wide row per auction with the
// nearest-feature distance (meters) per category, computed nightly by the
// WP-5 precompute job against geo_features. A search filter becomes a plain
// numeric column comparison instead of a live geometry query; sorting
// ("nearest to the sea first") is a plain ORDER BY.
//
// A distance column, not a boolean: it answers any radius, including ones
// not anticipated when the column was added. NULL means "nothing of this
// kind within the category's cutoff", which is different from "not computed
// yet" (a missing row) — WP-5 owns the exact per-category cutoffs and must
// keep the search UI's slider maximum in sync with them (see the
// architecture doc's cutoff/NULL-semantics section).
//
// Only the categories the architecture doc names concretely are modeled
// here (sea/lake/river/mountain/airport already exist today via
// osm_local_elements; ski_area and the tourism-density count are named
// explicitly as the first additions). WP-6's wishlist categories (hiking,
// mtb, canoe, marina, fishing, attractions, thermal/wellness) are additive
// columns for a later migration, not a reason to guess their shape now.
export const auctionGeoMetrics = pgTable('auction_geo_metrics', {
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  distSeaM: integer('dist_sea_m'),
  distLakeM: integer('dist_lake_m'),
  distRiverM: integer('dist_river_m'),
  distMountainM: integer('dist_mountain_m'),
  distAirportM: integer('dist_airport_m'),
  distSkiM: integer('dist_ski_m'),
  // Count within a fixed radius, not a distance — density is the more
  // meaningful tourism signal (does the area have tourist infrastructure at
  // all), per the architecture doc's "touristische Erschließung" note.
  tourismDensityCount: integer('tourism_density_count'),
  climateCellId: bigint('climate_cell_id', { mode: 'number' }).references(() => climateCells.id, { onDelete: 'set null' }),
  // Hash of the auctions.lat/lng this row was computed from — an auction's
  // coordinates changing (re-geocoding) invalidates the row without needing
  // a separate "dirty" flag.
  pointHash: text('point_hash'),
  featuresEpoch: integer('features_epoch').notNull().default(1),
  computedAt: timestamp('computed_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.platform, table.externalId] }),
  foreignKey({
    name: 'fk_auction_geo_metrics_auction',
    columns: [table.platform, table.externalId],
    foreignColumns: [auctions.platform, auctions.externalId],
  }).onDelete('cascade'),
]).enableRLS()
