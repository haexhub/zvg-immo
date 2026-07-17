-- Idempotent bootstrap, run on every boot via runMigrations() (see
-- server/utils/db.ts). Phase 1 has nothing app-specific to create yet — this
-- just ensures pgcrypto is available for gen_random_uuid(), which every
-- later phase's uuid primary keys (saved_searches, watchlist_items, ...)
-- depend on. Later phases append their own CREATE TABLE blocks below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Phase 2: gespeicherte Suchen + Watchlist. `filters` mirrors the query-param
-- names pages/index.vue reads/writes (see lib/auction-filters.ts). `auth.users`
-- is created by GoTrue's own migrations, not this file — the `app` service's
-- depends_on: { auth: { condition: service_healthy } } (docker-compose.yml)
-- ensures that table exists before this runs.
CREATE TABLE IF NOT EXISTS saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  filters     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform      text NOT NULL,
  zvg_id        text NOT NULL,
  amtsgericht   text,
  aktenzeichen  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, zvg_id)
);

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON saved_searches;
DROP POLICY IF EXISTS own_rows ON watchlist_items;
CREATE POLICY own_rows ON saved_searches FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY own_rows ON watchlist_items FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Phase 3: append-only auction history for Grafana + the alert matcher. One
-- row per auction per `refresh` run (server/utils/history.ts), never
-- updated — plain table, no hypertable/Timescale (current row volumes don't
-- justify the extension dependency on the self-host stack).
CREATE TABLE IF NOT EXISTS auction_observations (
  id                bigserial PRIMARY KEY,
  captured_at       timestamptz NOT NULL,
  platform          text NOT NULL,
  country           text NOT NULL,
  region            text NOT NULL,
  zvg_id            text NOT NULL,
  amtsgericht       text NOT NULL,
  aktenzeichen      text NOT NULL,
  objekt            text,
  property_type     text,
  land_area_sqm     numeric,
  living_area_sqm   numeric,
  rooms             numeric,
  units             integer,
  verkehrswert_eur  numeric,
  termin_iso        timestamptz,
  aufgehoben        boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_country_region_time ON auction_observations (country, region, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_platform_zvgid_time ON auction_observations (platform, zvg_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_az_time ON auction_observations (amtsgericht, aktenzeichen, captured_at DESC);

-- Phase 3: alert subscriptions (one enabled saved search = one subscription,
-- toggled via server/api/alerts/[savedSearchId].put.ts) + the dedup ledger
-- that keeps refresh's alert matcher (server/utils/alert-matching.ts) from
-- re-mailing the same match on every subsequent run.
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  saved_search_id  uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saved_search_id)
);
ALTER TABLE alert_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON alert_subscriptions;
CREATE POLICY own_rows ON alert_subscriptions FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS notified_matches (
  id                      bigserial PRIMARY KEY,
  alert_subscription_id   uuid NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
  platform                text NOT NULL,
  zvg_id                  text NOT NULL,
  notified_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_subscription_id, platform, zvg_id)
);
-- notified_matches: no RLS — server-internal only, never exposed to a client.
