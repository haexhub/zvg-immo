-- The three partial indexes were created on production by hand with
-- CREATE INDEX CONCURRENTLY (docs/plans/2026-10-19-osm-context-partial-indexes.md),
-- so IF NOT EXISTS makes this a no-op there and only builds them on a fresh
-- database. The plain GIST on geom had zero scans; every query casts to geography.
-- Drop idx_osm_local_elements_geom separately with DROP INDEX CONCURRENTLY;
-- Drizzle runs this migration in a transaction and PostgreSQL does not allow
-- the concurrent form there.
CREATE INDEX IF NOT EXISTS "idx_osm_local_elements_geog_railway_station" ON "osm_local_elements" USING gist ((("geom")::geography)) WHERE ("osm_local_elements"."tags" ->> 'railway') IN ('station', 'halt', 'tram_stop');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_osm_local_elements_geog_place" ON "osm_local_elements" USING gist ((("geom")::geography)) WHERE ("osm_local_elements"."tags" ->> 'place') IN ('city', 'town', 'suburb', 'village', 'hamlet', 'island', 'municipality');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_osm_local_elements_geog_train_route" ON "osm_local_elements" USING gist ((("geom")::geography)) WHERE "osm_local_elements"."osm_type" = 'relation' AND ("osm_local_elements"."tags" ->> 'type') = 'route' AND ("osm_local_elements"."tags" ->> 'route') = 'train';
