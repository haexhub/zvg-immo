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

-- Phase 4: lawyer referral (pay-per-lead, the lawyer pays a commission per
-- inquiry). `lawyers` is an admin-maintained catalog (CRUD under
-- server/api/settings/lawyers/*, guarded by the existing settings-auth
-- middleware) — public reads go through server/api/lawyers.get.ts, which
-- filters to `active` rows and strips `email` before returning JSON; the
-- column itself carries no extra protection here since this table has no
-- RLS (see below). `countries` holds lowercase ISO-2 codes matching
-- Auction.country (types/auction.ts), so `countries @> ARRAY[auction.country]`
-- needs no case conversion.
CREATE TABLE IF NOT EXISTS lawyers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  firm              text,
  email             text NOT NULL,
  phone             text,
  countries         text[] NOT NULL,
  specialization    text,
  languages         text[],
  website           text,
  commission_cents  integer,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lawyers_countries ON lawyers USING gin (countries);

-- One row per inquiry a logged-in user sends to a lawyer via
-- server/api/lawyer-inquiries/index.post.ts — the billing record for that
-- lawyer's pay-per-lead commission. `commission_cents` is snapshotted from
-- `lawyers.commission_cents` at insert time so a later tariff change doesn't
-- rewrite historical amounts. `lawyer_id` is ON DELETE RESTRICT: lawyers with
-- existing inquiries can't be deleted, only deactivated (`active = false`) —
-- the inquiry rows are billing records, not disposable.
CREATE TABLE IF NOT EXISTS lawyer_inquiries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lawyer_id         uuid NOT NULL REFERENCES lawyers(id) ON DELETE RESTRICT,
  platform          text,
  zvg_id            text,
  message           text NOT NULL,
  commission_cents  integer,
  commission_status text NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiries_lawyer_time ON lawyer_inquiries (lawyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_user_time ON lawyer_inquiries (user_id, created_at DESC);

ALTER TABLE lawyer_inquiries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON lawyer_inquiries;
CREATE POLICY own_rows ON lawyer_inquiries FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- lawyers: no RLS — catalog/config table, public read is server-filtered
-- (active + public-safe fields only), writes are admin-only (settings-auth).

-- Phase 5: self-service API keys for the Daten-API (/api/data/v1/*, see
-- server/utils/api-key.ts + server/middleware/data-api-auth.ts). Plaintext
-- keys are never stored — only a SHA-256 hash (unique-indexed lookup) and a
-- short prefix for display survive the request that created them.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON api_keys;
CREATE POLICY own_rows ON api_keys FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Phase 5: per-day request counter per key, for a later billing phase (see
-- server/middleware/data-api-auth.ts). Burst protection itself runs on the
-- existing in-memory rate limiter, not on this table.
CREATE TABLE IF NOT EXISTS api_usage (
  api_key_id  uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day         date NOT NULL,
  count       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day)
);
-- api_usage: no RLS — server-internal counting, never exposed directly to a client.
