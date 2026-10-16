-- Custom SQL migration file, put your code below! --

-- pgcrypto: gen_random_uuid() defaults on every uuid primary key below.
-- postgis: geometry columns (osm_local_elements, geo_features) and the
-- customType() wrapper in server/db/schema/geo.ts both assume this is
-- available before any CREATE TABLE runs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;