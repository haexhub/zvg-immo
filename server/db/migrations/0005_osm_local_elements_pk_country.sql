-- ADD CONSTRAINT ... PRIMARY KEY below holds an ACCESS EXCLUSIVE lock on
-- osm_local_elements for the whole index build. A CONCURRENTLY-built index
-- swapped in via `PRIMARY KEY USING INDEX` would avoid that, but
-- server/utils/db.ts runs all migrations through drizzle-orm's migrate(),
-- which wraps every statement in one transaction — CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. Splitting this into a
-- non-transactional migration path is out of scope here; the brief lock is
-- accepted.
ALTER TABLE "osm_local_elements" DROP CONSTRAINT "osm_local_elements_osm_type_osm_id_pk";--> statement-breakpoint
ALTER TABLE "osm_local_elements" ADD CONSTRAINT "osm_local_elements_osm_type_osm_id_country_pk" PRIMARY KEY("osm_type","osm_id","country");