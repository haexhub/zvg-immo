-- Idempotent bootstrap, run on every boot via runMigrations() (see
-- server/utils/db.ts). Phase 1 has nothing app-specific to create yet — this
-- just ensures pgcrypto is available for gen_random_uuid(), which every
-- later phase's uuid primary keys (saved_searches, watchlist_items, ...)
-- depend on. Later phases append their own CREATE TABLE blocks below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

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
  external_id   text NOT NULL,
  authority     text,
  case_number   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_id)
);

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON saved_searches;
DROP POLICY IF EXISTS own_rows ON watchlist_items;
CREATE POLICY own_rows ON saved_searches FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY own_rows ON watchlist_items FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Phase 3: append-only auction history for Grafana + analyses. Refresh writes
-- the listing-level state and enrich writes the final detail-decorated state
-- (server/utils/history.ts). Plain table, no hypertable/Timescale (current row
-- volumes don't justify the extension dependency on the self-host stack).
CREATE TABLE IF NOT EXISTS auction_observations (
  id                bigserial PRIMARY KEY,
  captured_at       timestamptz NOT NULL,
  platform          text NOT NULL,
  country           text NOT NULL,
  region            text NOT NULL,
  external_id       text NOT NULL,
  authority         text NOT NULL,
  case_number       text NOT NULL,
  title             text,
  property_type     text,
  land_area_sqm     numeric,
  living_area_sqm   numeric,
  rooms             numeric,
  units             integer,
  market_value_eur  numeric,
  -- WP-2: native value + ISO-4217 currency (source of truth); market_value_eur
  -- is derived from these (deriveMarketValueEur, server/utils/exchange-rate.ts).
  market_value      numeric,
  currency          text,
  auction_date_iso  timestamptz,
  cancelled         boolean NOT NULL
);
-- The typed columns above keep common time-series queries fast. `payload`
-- preserves the complete parsed source record for every observation so new
-- fields can be analysed historically without having to predict them here.
-- It is intentionally append-only together with the rest of the row.
ALTER TABLE auction_observations ADD COLUMN IF NOT EXISTS payload jsonb;
CREATE INDEX IF NOT EXISTS idx_obs_country_region_time ON auction_observations (country, region, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_platform_zvgid_time ON auction_observations (platform, external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_az_time ON auction_observations (authority, case_number, captured_at DESC);
-- Server-intern befüllt, aber trotzdem RLS an (ohne Policies, Default-Deny) —
-- sonst läse/schriebe PostgREST-anon/authenticated direkt mit; der
-- Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE auction_observations ENABLE ROW LEVEL SECURITY;

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
  external_id             text NOT NULL,
  notified_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_subscription_id, platform, external_id)
);
-- notified_matches: server-internal only, but still exposed to PostgREST's
-- anon/authenticated roles by default while RLS is off. Enable it with no
-- policies (default-deny for those roles); the backend connects as the
-- table owner (postgres), which bypasses RLS, so app access is unaffected.
ALTER TABLE notified_matches ENABLE ROW LEVEL SECURITY;

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
-- No policies: PostgREST's anon/authenticated roles get default-deny; public
-- reads keep going through the server-filtered server/api/lawyers.get.ts,
-- which connects as the table owner (postgres) and so bypasses RLS.
ALTER TABLE lawyers ENABLE ROW LEVEL SECURITY;

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
  external_id       text,
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
-- api_usage: server-internal counting, but still needs RLS enabled (no
-- policies, default-deny) so PostgREST's anon/authenticated roles can't read
-- or write it — the backend connects as the table owner and bypasses RLS.
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;

-- WP-1: Terminologie-Rename (DE/ZVG-Feldnamen -> neutrales Englisch). Reiner
-- Rename, keine Verhaltensänderung — betrifft nur bereits existierende
-- Prod-Tabellen; die CREATE TABLE-Blöcke oben legen neue Installationen schon
-- mit den neuen Spaltennamen an, daher genügt hier ein einmaliges RENAME pro
-- Spalte (idempotent: nach dem ersten Lauf existiert die alte Spalte nicht
-- mehr, der jeweilige IF EXISTS-Check greift dann nicht mehr).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'watchlist_items' AND column_name = 'zvg_id') THEN
    ALTER TABLE watchlist_items RENAME COLUMN zvg_id TO external_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'watchlist_items' AND column_name = 'amtsgericht') THEN
    ALTER TABLE watchlist_items RENAME COLUMN amtsgericht TO authority;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'watchlist_items' AND column_name = 'aktenzeichen') THEN
    ALTER TABLE watchlist_items RENAME COLUMN aktenzeichen TO case_number;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'zvg_id') THEN
    ALTER TABLE auction_observations RENAME COLUMN zvg_id TO external_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'amtsgericht') THEN
    ALTER TABLE auction_observations RENAME COLUMN amtsgericht TO authority;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'aktenzeichen') THEN
    ALTER TABLE auction_observations RENAME COLUMN aktenzeichen TO case_number;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'objekt') THEN
    ALTER TABLE auction_observations RENAME COLUMN objekt TO title;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'verkehrswert_eur') THEN
    ALTER TABLE auction_observations RENAME COLUMN verkehrswert_eur TO market_value_eur;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'termin_iso') THEN
    ALTER TABLE auction_observations RENAME COLUMN termin_iso TO auction_date_iso;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_observations' AND column_name = 'aufgehoben') THEN
    ALTER TABLE auction_observations RENAME COLUMN aufgehoben TO cancelled;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lawyer_inquiries' AND column_name = 'zvg_id') THEN
    ALTER TABLE lawyer_inquiries RENAME COLUMN zvg_id TO external_id;
  END IF;

  -- Nicht im ursprünglichen Mapping-Dokument gelistet, aber derselbe
  -- (platform, zvg_id)-Spaltentyp wie die drei Tabellen oben — der Konsistenz
  -- halber gleich mit umbenannt.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notified_matches' AND column_name = 'zvg_id') THEN
    ALTER TABLE notified_matches RENAME COLUMN zvg_id TO external_id;
  END IF;
END $$;

-- saved_searches.filters (jsonb) spiegelt die Query-Param-Namen aus
-- lib/auction-filters.ts / pages/index.vue 1:1 — court/kat/aufgehoben sind
-- jetzt authority/category/cancelled. Bestehende gespeicherte Suchen mit den
-- alten Keys würden sonst still leerlaufen (Key wird nie gelesen). Idempotent:
-- die WHERE-Klausel greift nur, solange noch ein alter Key vorhanden ist.
UPDATE saved_searches
SET filters = (filters - 'court' - 'kat' - 'aufgehoben')
  || jsonb_strip_nulls(jsonb_build_object(
       'authority', filters->'court',
       'category', filters->'kat',
       'cancelled', filters->'aufgehoben'
     ))
WHERE filters ?| array['court', 'kat', 'aufgehoben'];

-- WP-2: Wert-Modell market_value+currency (Originalwert/-währung, Source of
-- Truth); market_value_eur bleibt, wird aber ab jetzt aus beiden abgeleitet
-- (deriveMarketValueEur, server/utils/exchange-rate.ts) statt direkt befüllt.
-- ADD COLUMN IF NOT EXISTS ist idempotent von Haus aus, kein DO-Block nötig.
ALTER TABLE auction_observations ADD COLUMN IF NOT EXISTS market_value numeric;
ALTER TABLE auction_observations ADD COLUMN IF NOT EXISTS currency text;

-- Bestehende Historie wurde ausschließlich in EUR erfasst — der Wert *war*
-- schon EUR, also verlustfrei genug, das als currency='EUR' zu annehmen.
-- Idempotent: die WHERE-Klausel greift nur, solange currency noch nicht gesetzt ist.
UPDATE auction_observations
SET market_value = market_value_eur, currency = 'EUR'
WHERE market_value_eur IS NOT NULL AND currency IS NULL;

-- Direct artifact cutover. Existing crawl data is disposable and recreated
-- from source, so old raw_* tables are dropped instead of renamed/backfilled.
DROP TABLE IF EXISTS raw_document_set_items;
DROP TABLE IF EXISTS raw_document_sets;
DROP TABLE IF EXISTS raw_captures;
DROP TABLE IF EXISTS raw_blobs;

-- WP-3: G1 Roh-Archiv Schicht 1. artifact_blobs = deduplizierte Bytes (S3-Key =
-- content_hash, sha256), artifact_captures = deduplizierter Capture-Index,
-- artifact_versions = versionierte "diese Dokumente galten zusammen"-
-- Manifeste pro Auktion (server/utils/raw-archive.ts).
CREATE TABLE IF NOT EXISTS artifact_blobs (
  content_hash  text PRIMARY KEY,          -- sha256 der kanonisierten Bytes
  s3_key        text NOT NULL,             -- sharded Key im Primary-Bucket, z.B. 'ab/abcd….json.gz'
  content_type  text NOT NULL,             -- 'application/json+gzip' | 'text/html+gzip' | 'application/pdf' | 'application/vnd.docx'
  byte_size     bigint NOT NULL,           -- Größe wie in der Outbox/S3 abgelegt (nach Kompression)
  first_seen_at timestamptz NOT NULL,
  uploaded_at   timestamptz                -- gesetzt, sobald Primary-Upload bestätigt (null = noch in Outbox)
);

-- country/region/authority/case_number lagen hier früher denormalisiert, weil
-- es keinen verlässlichen auctions-Anker gab. Seit dem Auction-Identity-
-- Redesign (WP-1) existiert die auctions-Zeile garantiert vor jedem Capture,
-- also kommen diese Felder per JOIN auf auctions.
CREATE TABLE IF NOT EXISTS artifact_captures (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL,
  kind          text NOT NULL,             -- 'auction' | 'document' | 'detail_html' | 'document_text' | 'photo'
  platform      text NOT NULL,
  external_id   text NOT NULL,             -- Auktions-Identität (immer vorhanden)
  content_hash  text NOT NULL REFERENCES artifact_blobs(content_hash),
  source_url    text                       -- Upstream-URL (Provenienz)
);
CREATE INDEX IF NOT EXISTS idx_capt_identity_time ON artifact_captures (platform, external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capt_hash          ON artifact_captures (content_hash);
-- One-time historical cleanup before adding the uniqueness guarantees below.
-- Keep only the newest parsed auction row per identity; for documents/detail/
-- text keep one row per identity+source_url+content_hash so updated documents
-- remain addressable by older document-set versions without re-adding
-- duplicates on every recrawl.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'raw_capture_dedupe_cleanup_20260727') THEN
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY kind, platform, external_id,
                            CASE WHEN kind = 'auction' THEN '' ELSE COALESCE(source_url, '') END,
                            CASE WHEN kind = 'auction' THEN '' ELSE content_hash END
               ORDER BY captured_at DESC, id DESC
             ) AS rn
      FROM artifact_captures
    )
    DELETE FROM artifact_captures rc USING ranked r
    WHERE rc.id = r.id AND r.rn > 1;

    INSERT INTO schema_migrations (name) VALUES ('raw_capture_dedupe_cleanup_20260727');
  END IF;
END $$;
-- The old uniqueness model keyed all captures by content_hash alone. The new
-- model deduplicates auction rows by identity+content_hash (append-only, a
-- new version per real change) and document rows by source URL+bytes.
DROP INDEX IF EXISTS idx_capt_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_capt_unique_auction_hash
  ON artifact_captures (kind, platform, external_id, content_hash)
  WHERE kind = 'auction';
CREATE UNIQUE INDEX IF NOT EXISTS idx_capt_unique_source_hash
  ON artifact_captures (kind, platform, external_id, (COALESCE(source_url, '')), content_hash)
  WHERE kind <> 'auction';

-- Gleiche Entdenormalisierung wie bei artifact_captures oben. uq_artifact_
-- versions_identity ist Voraussetzung für die zusammengesetzte FK von
-- auction_details (WP-2): sie stellt sicher, dass eine Extraktions-Version nur
-- ein Manifest der eigenen Auktion referenzieren kann.
CREATE TABLE IF NOT EXISTS artifact_versions (
  id              bigserial PRIMARY KEY,
  captured_at     timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  platform        text NOT NULL,
  external_id     text NOT NULL,
  set_hash        text NOT NULL,
  version         integer NOT NULL,
  document_count  integer NOT NULL,
  UNIQUE (platform, external_id, set_hash),
  UNIQUE (platform, external_id, version),
  CONSTRAINT uq_artifact_versions_identity UNIQUE (id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_sets_identity_version
  ON artifact_versions (platform, external_id, version DESC);

CREATE TABLE IF NOT EXISTS artifact_version_items (
  set_id        bigint NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,
  kind          text NOT NULL,
  label         text,
  filename      text,
  file_id       text,
  source_url    text NOT NULL,
  content_hash  text NOT NULL REFERENCES artifact_blobs(content_hash),
  content_type  text NOT NULL,
  PRIMARY KEY (set_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_doc_set_items_hash ON artifact_version_items (content_hash);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'raw_blob_orphan_cleanup_20260727') THEN
    DELETE FROM artifact_blobs rb
    WHERE NOT EXISTS (SELECT 1 FROM artifact_captures rc WHERE rc.content_hash = rb.content_hash)
      AND NOT EXISTS (SELECT 1 FROM artifact_version_items rdsi WHERE rdsi.content_hash = rb.content_hash);

    INSERT INTO schema_migrations (name) VALUES ('raw_blob_orphan_cleanup_20260727');
  END IF;
END $$;
-- Server-intern, nie clientseitig exponiert — trotzdem RLS aktivieren (ohne
-- Policies, also Default-Deny), sonst liest/schreibt PostgREST-anon/authenticated
-- munter mit; der Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE artifact_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_version_items ENABLE ROW LEVEL SECURITY;

-- WP-8: i18n Baustein B (Content-Übersetzung). content_hash = sha256 over
-- the translatable aggregate fields.
-- (raw-archive.ts's sha256Hex, siehe server/api/.../translation.post.ts):
-- unveränderter Inhalt -> Cache-Treffer, geänderter Inhalt -> neuer Hash und
-- damit eine neue Übersetzung. Immutabel pro
-- (content_hash, lang), keine destructive Invalidierung nötig.
CREATE TABLE IF NOT EXISTS content_translations (
  content_hash  text NOT NULL,
  lang          text NOT NULL,
  title         text,
  description   text,
  document_summary text,
  extraction_texts jsonb,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, lang)
);
ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS document_summary text;
ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS extraction_texts jsonb;
ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS address text;
-- RLS ohne Policies (Default-Deny): sperrt PostgREST-anon/authenticated aus,
-- der Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE content_translations ENABLE ROW LEVEL SECURITY;

-- A translation is claimed exactly once per auction and target language.
-- content_translations remains the content-addressed value store; this table
-- is the durable auction-level gate that prevents a changed source payload,
-- another app instance, or a concurrent request from starting a second LLM
-- translation. Failed attempts are retained with their error instead of being
-- silently treated as a cache miss.
CREATE TABLE IF NOT EXISTS auction_translations (
  platform          text NOT NULL,
  external_id       text NOT NULL,
  lang              text NOT NULL,
  content_hash      text NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  title             text,
  description       text,
  document_summary  text,
  extraction_texts  jsonb,
  error_message     text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  PRIMARY KEY (platform, external_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_auction_translations_status
  ON auction_translations (status, started_at);
ALTER TABLE auction_translations ENABLE ROW LEVEL SECURITY;
-- Fingerprint (sha256 of provider+baseUrl+model+apiKey) of the LLM config
-- that produced a 'failed' row's error — lets a /settings provider/model
-- switch bypass the retry-after-1h backoff immediately instead of replaying
-- the old config's stale error for the rest of that window.
ALTER TABLE auction_translations ADD COLUMN IF NOT EXISTS failed_config text;
ALTER TABLE auction_translations ADD COLUMN IF NOT EXISTS address text;

-- Place names (nearby settlements, industrial sites, airports — all sourced
-- from OSM's `name`/`name:xx` tags via osm-location-shared.ts's nameOf()) are
-- shared across every auction near that place, so they're translated/
-- transliterated into a cache keyed by the name itself rather than bundled
-- into auction_translations/content_translations above — one auction's
-- unrelated title/description shouldn't fragment the cache key for a place
-- name hundreds of other auctions also reference.
CREATE TABLE IF NOT EXISTS place_name_translations (
  name       text NOT NULL,
  lang       text NOT NULL,
  translated text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, lang)
);
ALTER TABLE place_name_translations ENABLE ROW LEVEL SECURITY;

-- Stable master identity. Object, price and extraction fields live only in
-- the immutable auction_details versions below; mutable crawl/pipeline state
-- lives in auction_fetch_state.
CREATE TABLE IF NOT EXISTS auctions (
  platform              text NOT NULL,
  external_id           text NOT NULL,
  country               text NOT NULL,
  region                text NOT NULL,
  authority             text NOT NULL,
  case_number           text NOT NULL,
  title                 text,
  auction_date_iso      timestamptz,
  auction_date_text     text,
  cancelled             boolean NOT NULL,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_auctions_country_region ON auctions (country, region);
-- Server-intern befüllt; öffentliche APIs lesen nur über kontrollierte
-- Server-DTOs. RLS trotzdem an, ohne Policies (Default-Deny), sonst
-- läse/schriebe PostgREST-anon/authenticated direkt mit.
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;

-- `auctions` is the master identity and is written before artifacts/details.
-- Normal crawls only upsert it; a country rebuild deliberately deletes the
-- complete country graph and recreates it from a fresh crawl.
-- server/utils/current-auctions.ts, aufgerufen im Crawl-Pfad VOR jedem
-- Archiv-/Extraktionsschreiber). Damit können artifact_captures/
-- artifact_versions endlich eine echte FK darauf tragen und ihre
-- denormalisierten Identitätsspalten abgeben.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS auction_date_text text;

-- Direct cutover from the former denormalized serving mirror. The data is
-- intentionally rebuilt by crawling, so no values are copied forward.
ALTER TABLE auctions
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS property_type,
  DROP COLUMN IF EXISTS land_area_sqm,
  DROP COLUMN IF EXISTS living_area_sqm,
  DROP COLUMN IF EXISTS rooms,
  DROP COLUMN IF EXISTS units,
  DROP COLUMN IF EXISTS market_value,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS market_value_eur,
  DROP COLUMN IF EXISTS photo_count,
  DROP COLUMN IF EXISTS thumbnail_url,
  DROP COLUMN IF EXISTS lat,
  DROP COLUMN IF EXISTS lng,
  DROP COLUMN IF EXISTS detail_fetched_at,
  DROP COLUMN IF EXISTS extraction_source,
  DROP COLUMN IF EXISTS extraction_confidence,
  DROP COLUMN IF EXISTS condition,
  DROP COLUMN IF EXISTS features,
  DROP COLUMN IF EXISTS starting_bid,
  DROP COLUMN IF EXISTS current_bid,
  DROP COLUMN IF EXISTS source_security_deposit,
  DROP COLUMN IF EXISTS security_deposit,
  DROP COLUMN IF EXISTS bidding_notes,
  DROP COLUMN IF EXISTS year_built,
  DROP COLUMN IF EXISTS last_renovation_year;

-- Remove the former denormalized archive identity fields without carrying
-- their values forward. Identity is recreated by the crawl before artifacts.
DROP INDEX IF EXISTS idx_capt_az_time;
DROP INDEX IF EXISTS idx_capt_country_region_time;
DROP INDEX IF EXISTS idx_doc_sets_country_region_time;
ALTER TABLE artifact_captures
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS region,
  DROP COLUMN IF EXISTS authority,
  DROP COLUMN IF EXISTS case_number;
ALTER TABLE artifact_versions
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS region,
  DROP COLUMN IF EXISTS authority,
  DROP COLUMN IF EXISTS case_number;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_artifact_versions_identity') THEN
    ALTER TABLE artifact_versions ADD CONSTRAINT uq_artifact_versions_identity UNIQUE (id, platform, external_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifact_captures_auction') THEN
    ALTER TABLE artifact_captures
      ADD CONSTRAINT fk_artifact_captures_auction
      FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifact_versions_auction') THEN
    ALTER TABLE artifact_versions
      ADD CONSTRAINT fk_artifact_versions_auction
      FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
-- Getrennt vom Block oben: VALIDATE auf einer bereits validierten Constraint
-- ist ein No-op, ein fehlgeschlagener Validierungslauf kann so beim nächsten
-- Boot nachgeholt werden statt am IF NOT EXISTS oben hängenzubleiben.
ALTER TABLE artifact_captures VALIDATE CONSTRAINT fk_artifact_captures_auction;
ALTER TABLE artifact_versions VALIDATE CONSTRAINT fk_artifact_versions_auction;

-- Typisierte, versionierte Detail- und Extraktionsdaten. Jede Zeile ist
-- unveränderlich — es gibt kein UPDATE,
-- die Versionsfolge IST die Historie. Typisierte Spalten statt einem JSON-Blob,
-- damit sich zwischen zwei Versionen per SQL diffen lässt, wo sich z.B.
-- living_area_sqm geändert hat.
--
-- `version` ist ein eigener Zähler, unabhängig von artifact_versions.version:
-- eine neue Extraktions-Version entsteht sowohl durch neue Dokumente als auch
-- durch einen erneuten LLM-Lauf auf denselben Dokumenten (reprocess.ts).
-- artifact_version_id hält fest, welches Manifest ausgewertet wurde.
CREATE TABLE IF NOT EXISTS auction_details (
  id                    bigserial PRIMARY KEY,
  platform              text NOT NULL,
  external_id           text NOT NULL,
  version               integer NOT NULL,
  artifact_version_id   bigint,  -- NULL = nur aus Listing-Daten, keine Dokumente geparst
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Fachlicher Extraktions-Zeitpunkt (= AuctionExtraction.at). Nicht durch
  -- created_at ersetzbar: bei Replay können die beiden abweichen.
  extracted_at          timestamptz NOT NULL,
  address               text,
  description           text,
  property_type         text,
  land_area_sqm         numeric,
  living_area_sqm       numeric,
  rooms                 numeric,
  bedrooms              numeric,
  bathrooms             numeric,
  floor                 text,
  bathroom_has_tub      boolean,
  bathroom_has_shower   boolean,
  heating               text,
  units                 integer,
  year_built            integer,
  last_renovation_year  integer,
  market_value          numeric,
  currency              text,
  market_value_eur      numeric,
  condition             jsonb,
  features              text[],
  insights              jsonb,
  planning_notes        jsonb,
  renovation_notes      text,
  starting_bid          numeric,
  current_bid           numeric,
  source_security_deposit numeric,
  security_deposit      numeric,
  bidding_notes         text,
  photo_count           integer NOT NULL DEFAULT 0,
  thumbnail_url         text,
  lat                   numeric,
  lng                   numeric,
  extraction_source     text,
  extraction_confidence text,
  llm_analyzed_at       timestamptz,
  document_summary      text,
  extraction_texts      jsonb,
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) ON DELETE CASCADE,
  -- Zusammengesetzt statt nur REFERENCES artifact_versions (id): verhindert,
  -- dass eine Zeile das Manifest einer FREMDEN Auktion referenziert.
  -- NULL bleibt erlaubt (MATCH SIMPLE prüft eine FK mit NULL-Spalte nicht).
  -- ON DELETE CASCADE: deleteRawArchiveCountry() (admin "Archiv löschen")
  -- löscht artifact_versions-Zeilen für ein Land direkt aus der DB. Ohne
  -- CASCADE würde das ab hier mit einem FK-Fehler abbrechen, sobald eine
  -- Extraktions-Version existiert. Wer das Roharchiv eines Landes löscht,
  -- will die davon abgeleitete Extraktions-Historie mitgelöscht haben, nicht
  -- eine Fehlermeldung.
  FOREIGN KEY (artifact_version_id, platform, external_id)
    REFERENCES artifact_versions (id, platform, external_id) ON DELETE CASCADE,
  UNIQUE (platform, external_id, version)
);
CREATE INDEX IF NOT EXISTS idx_auction_details_identity_version
  ON auction_details (platform, external_id, version DESC);
-- Für die "aktueller Stand"-Filterabfragen aus WP-3 (Suche/Karte).
CREATE INDEX IF NOT EXISTS idx_auction_details_property_type ON auction_details (property_type);
CREATE INDEX IF NOT EXISTS idx_auction_details_living_area ON auction_details (living_area_sqm);
CREATE INDEX IF NOT EXISTS idx_auction_details_land_area ON auction_details (land_area_sqm);
CREATE INDEX IF NOT EXISTS idx_auction_details_year_built ON auction_details (year_built);
ALTER TABLE auction_details ENABLE ROW LEVEL SECURITY;

-- Auction-Details-Completion WP-10: source-provided structured values and the
-- original market-value wording belong to the immutable extraction version.
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_living_area_sqm numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_land_area_sqm numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_rooms numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS market_value_text text;

-- Auction-Details-Completion WP-9: curated photos are extraction output and
-- therefore versioned through auction_details. The actual image files remain
-- in the image bucket; artifact_blobs is the document archive and deliberately
-- has no FK relationship to this table.
CREATE TABLE IF NOT EXISTS auction_photos (
  id                  bigserial PRIMARY KEY,
  auction_details_id  bigint NOT NULL REFERENCES auction_details (id) ON DELETE CASCADE,
  ordinal             integer NOT NULL,
  file                text NOT NULL,
  category            text NOT NULL,
  caption             text,
  is_property_photo   boolean NOT NULL,
  UNIQUE (auction_details_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_auction_photos_details
  ON auction_photos (auction_details_id, ordinal);
ALTER TABLE auction_photos ENABLE ROW LEVEL SECURITY;

-- Auction-Identity-Redesign WP-4: Übersetzungen hängen jetzt an einer konkreten
-- auction_details-Version statt nur an der Auktion. Der Inhalt ist
-- versionsabhängig — eine neue Extraktions-Version kann Titel/Beschreibung
-- ändern —, alte Übersetzungen bleiben als Historie erhalten statt
-- überschrieben zu werden. NOT NULL geht nicht direkt per ADD COLUMN auf eine
-- gefüllte Tabelle: nullable anlegen, vorhandene Zeilen zuordnen, dann NOT NULL setzen.
ALTER TABLE auction_translations ADD COLUMN IF NOT EXISTS version integer;
UPDATE auction_translations SET version = 1 WHERE version IS NULL;
ALTER TABLE auction_translations ALTER COLUMN version SET NOT NULL;
-- Der alte PK (platform, external_id, lang) ließe keine zweite Version
-- derselben Sprache zu.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'auction_translations'::regclass AND i.indisprimary AND att.attname = 'version'
  ) THEN
    ALTER TABLE auction_translations DROP CONSTRAINT auction_translations_pkey;
    ALTER TABLE auction_translations ADD PRIMARY KEY (platform, external_id, version, lang);
  END IF;

  -- ON DELETE CASCADE: auction_details rows themselves cascade away when
  -- their artifact_versions manifest is deleted (WP-2, deleteRawArchiveCountry
  -- admin action) — without the same here, that cascade would stop one layer
  -- too early and fail on any translated version instead of taking the
  -- translation history with it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_auction_translations_details') THEN
    ALTER TABLE auction_translations
      ADD CONSTRAINT fk_auction_translations_details
      FOREIGN KEY (platform, external_id, version) REFERENCES auction_details (platform, external_id, version)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  -- NOT VALID greift bereits für jeden neuen Schreibzugriff. Validiert wird,
  -- sobald jede vorhandene Übersetzung einer Details-Version zugeordnet ist.
  IF NOT EXISTS (
    SELECT 1 FROM auction_translations t
    WHERE NOT EXISTS (
      SELECT 1 FROM auction_details ad
      WHERE ad.platform = t.platform AND ad.external_id = t.external_id AND ad.version = t.version
    )
  ) THEN
    ALTER TABLE auction_translations VALIDATE CONSTRAINT fk_auction_translations_details;
  END IF;
END $$;


-- Direct structured cutover: crawl data is cheap to recreate, so obsolete
-- JSON serving/cache tables are removed instead of backfilled or dual-written.
DROP TABLE IF EXISTS extraction_cache;
DROP TABLE IF EXISTS auction_snapshot;

-- WP-5: Read-Path auf Postgres. Ersetzt die beiden lokalen JSON-Caches
-- (.cache_zvg/list/<country>-<region>.json, .cache_zvg/auctions.json) als
-- alleinige Serving-Quelle (Design-Entscheidung E1) — Postgres ist jetzt der
-- Serving-Store, nicht mehr nur ein Filter-Spiegel wie `auctions` oben.
--
-- list_cache: ein Blob pro Region, exakt wie die bisherige Datei — von
-- refresh.ts in seiner bestehenden Pro-Portal-Cadence geschrieben (siehe
-- crawl-cadence.ts), keine Aktualitäts-Regression gegenüber dem Datei-Stand.
CREATE TABLE IF NOT EXISTS list_cache (
  country     text NOT NULL,
  region      text NOT NULL,
  result      jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (country, region)
);
ALTER TABLE list_cache ENABLE ROW LEVEL SECURITY;

-- Auction-Details-Completion WP-8: mutable crawl and pipeline state. Two
-- independent writers own disjoint column groups; application writes update
-- only their own columns so concurrent crawl/photo/LLM work cannot reset the
-- other group's values to NULL or defaults.
CREATE TABLE IF NOT EXISTS auction_fetch_state (
  platform               text NOT NULL,
  external_id            text NOT NULL,
  pdf_url                text,
  pdf_url_upstream       text,
  detail_url             text,
  detail_url_upstream    text,
  attachments            jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_urls             text[],
  source_updated_iso     timestamptz,
  detail_fetched_at      timestamptz,
  llm_batch_job          text,
  llm_artifact_version_id bigint,
  llm_failures           integer NOT NULL DEFAULT 0,
  photos_checked_at      timestamptz,
  photo_failures         integer NOT NULL DEFAULT 0,
  photo_pipeline_version integer,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id),
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) ON DELETE CASCADE,
  CONSTRAINT fk_auction_fetch_state_llm_artifact
    FOREIGN KEY (llm_artifact_version_id, platform, external_id)
    REFERENCES artifact_versions (id, platform, external_id)
    ON DELETE SET NULL (llm_artifact_version_id)
);
ALTER TABLE auction_fetch_state
  ADD COLUMN IF NOT EXISTS llm_artifact_version_id bigint;
UPDATE auction_fetch_state fs
SET llm_artifact_version_id = NULL
WHERE fs.llm_artifact_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM artifact_versions av
    WHERE av.id = fs.llm_artifact_version_id
      AND av.platform = fs.platform
      AND av.external_id = fs.external_id
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_auction_fetch_state_llm_artifact'
  ) THEN
    ALTER TABLE auction_fetch_state
      ADD CONSTRAINT fk_auction_fetch_state_llm_artifact
      FOREIGN KEY (llm_artifact_version_id, platform, external_id)
      REFERENCES artifact_versions (id, platform, external_id)
      ON DELETE SET NULL (llm_artifact_version_id)
      NOT VALID;
  END IF;
END $$;
ALTER TABLE auction_fetch_state
  VALIDATE CONSTRAINT fk_auction_fetch_state_llm_artifact;
CREATE INDEX IF NOT EXISTS idx_auction_fetch_state_llm_batch_job
  ON auction_fetch_state (llm_batch_job) WHERE llm_batch_job IS NOT NULL;
ALTER TABLE auction_fetch_state ENABLE ROW LEVEL SECURITY;

-- External market/hazard enrichment is intentionally stored outside the LLM
-- extraction result: provider licenses, TTLs and source versions have their
-- own cadence, and detail pages only ever read the cached result.
CREATE TABLE IF NOT EXISTS location_enrichment (
  platform      text NOT NULL,
  external_id   text NOT NULL,
  enrichment    jsonb NOT NULL,
  checked_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_location_enrichment_checked_at ON location_enrichment (checked_at DESC);
ALTER TABLE location_enrichment ENABLE ROW LEVEL SECURITY;

-- Auction-Identity-Redesign WP-5: echte FK auf die Auktions-Identität. Bewusst
-- unversioniert — der Standort ändert sich nicht zwischen Extraktions-
-- Versionen, er wird bei einer spürbaren Koordinatenänderung überschrieben
-- (siehe server/utils/auction-details.ts).
--
-- Gleiches NOT VALID-Muster wie bei auction_translations (WP-4): neue Writes
-- sind sofort abgesichert, validiert wird erst, wenn keine Altzeile mehr ohne
-- auctions-Zeile existiert — ein Boot davor soll nicht daran scheitern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_location_enrichment_auction') THEN
    ALTER TABLE location_enrichment
      ADD CONSTRAINT fk_location_enrichment_auction
      FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM location_enrichment le
    WHERE NOT EXISTS (
      SELECT 1 FROM auctions a WHERE a.platform = le.platform AND a.external_id = le.external_id
    )
  ) THEN
    ALTER TABLE location_enrichment VALIDATE CONSTRAINT fk_location_enrichment_auction;
  END IF;
END $$;

-- llm_batch_jobs: tracks in-flight LLM Batch API jobs submitted by
-- enrich.ts/reprocess.ts. Gemini echoes the submitted `key` directly in its
-- result JSONL; Anthropic restricts `custom_id` to a short safe alphabet, so
-- custom_id_map stores `{ custom_id: "platform:externalId" }` for those jobs.
CREATE TABLE IF NOT EXISTS llm_batch_jobs (
  job_name     text PRIMARY KEY,
  source       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  item_count   integer NOT NULL,
  custom_id_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  checked_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  error_message text
);
ALTER TABLE llm_batch_jobs ADD COLUMN IF NOT EXISTS custom_id_map jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Reason a job resolved as 'failed'/'expired' (poll-time, from the provider's
-- own error field) — previously only reached a console.warn, invisible from
-- /settings, which let a structurally-broken batch path (Gemini free tier
-- has no Batch API access at all — see gemini-batch.ts) run silently for
-- hours before anyone noticed.
ALTER TABLE llm_batch_jobs ADD COLUMN IF NOT EXISTS error_message text;
-- RLS ohne Policies (Default-Deny), gleiches Muster wie oben: server-intern,
-- Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE llm_batch_jobs ENABLE ROW LEVEL SECURITY;

-- app_settings: generischer Key/Value-Store für admin-konfigurierbare
-- Dashboard-Settings ohne Redeploy (siehe
-- docs/plans/2026-07-23-llm-max-output-tokens-config.md), erster Nutzer sind
-- die LLM-Max-Output-Tokens-Limits (server/utils/app-settings.ts). Analog zu
-- `lawyers`: RLS an, keine Policies — Server verbindet als Tabellenbesitzer
-- und umgeht RLS ohnehin, PostgREST-anon/authenticated bleiben ausgesperrt.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Rollback von PR #186 (27.7.2026): der "aktueller Stand"-Index für
-- kind='auction' hat das vorherige append-only-Verhalten (eine neue Zeile
-- pro echter Content-Änderung, wie es document/detail_html/document_text
-- weiterhin haben) versehentlich durch ein reines Überschreiben ersetzt und
-- damit die historischen Auktions-Versionen unwiederbringlich gelöscht. Die
-- kanonische Index-Deklaration oben (idx_capt_unique_auction_hash) ist bereits
-- auf das append-only-Verhalten zurückgestellt; hier nur noch der einmalige
-- Drop des jetzt obsoleten Index für Datenbanken, die PR #186 bereits
-- durchlaufen haben — ohne diesen würde die obige CREATE-Anweisung auf
-- solchen Datenbanken nie greifen, weil idx_capt_unique_auction_current dort
-- schon existiert. Der Cleanup von PR #186 hat bereits jede Auktion auf genau
-- eine Zeile reduziert, daher kann der neue Unique-Index beim Anlegen nicht
-- auf Duplikate stoßen.
DROP INDEX IF EXISTS idx_capt_unique_auction_current;

-- Generisches Cache für on-demand LLM-Insight-Karten (Nutzungsideen, später
-- Sanierungskosten, Anschlüsse, ...). Ein Table für jedes künftige Insight
-- statt einem Table pro Feature. Immutabel pro (insight_id, content_hash),
-- gleicher Vertrag wie content_translations.
CREATE TABLE IF NOT EXISTS auction_insights (
  insight_id    text NOT NULL,
  content_hash  text NOT NULL,
  payload       jsonb NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (insight_id, content_hash)
);
ALTER TABLE auction_insights ENABLE ROW LEVEL SECURITY;

-- task_run_errors: per-item error history for tracked tasks (enrich/
-- reprocess/...), distinct from task_run_status's single lastWarning/
-- lastError string (app_settings, overwritten every run and truncated to
-- the first 20 entries — see enrich.ts). The underlying fetch/network
-- failure reason used to be swallowed entirely (bare `catch { return null }`
-- in llm-documents.ts/native-images.ts/document-images.ts); container
-- restarts and short journalctl retention meant it was gone for good. Rows
-- age out on write (see task-run-errors.ts) instead of a fixed row cap.
CREATE TABLE IF NOT EXISTS task_run_errors (
  id           bigserial PRIMARY KEY,
  task         text NOT NULL,
  platform     text,
  external_id  text,
  category     text NOT NULL,
  message      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_run_errors_task_created ON task_run_errors (task, created_at DESC);
ALTER TABLE task_run_errors ENABLE ROW LEVEL SECURITY;

-- Local OSM data (loaded out-of-band by a standalone osm2pgsql job, not by
-- this app) replacing the live public Overpass API as the location-context
-- source (server/utils/external-data/osm-local.ts) — overpass-api.de started
-- timing out under the nightly full-dataset external-enrichment run. Real
-- geometry (not just a center point) on purpose, even though
-- buildLocationContext only ever consumes a single representative point per
-- element today: this table is meant to carry future geodata features too
-- (user-drawn search-area polygons, "within N km of the coast" filters)
-- without a schema change.
CREATE TABLE IF NOT EXISTS osm_local_elements (
  osm_type    text NOT NULL,
  osm_id      bigint NOT NULL,
  geom        geometry(Geometry, 4326) NOT NULL,
  tags        jsonb NOT NULL,
  country     text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX IF NOT EXISTS idx_osm_local_elements_geom ON osm_local_elements USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_local_elements_country ON osm_local_elements (country);
-- Landing-page geo rails (server/api/landing/rails.get.ts) filter each
-- candidate auction with `country = $1 AND tags ->> 'natural'/'waterway' = $2`
-- inside an EXISTS subquery; these composite expression indexes let that
-- lookup use an index scan instead of a per-row jsonb scan.
CREATE INDEX IF NOT EXISTS idx_osm_local_elements_country_natural ON osm_local_elements (country, (tags ->> 'natural'));
CREATE INDEX IF NOT EXISTS idx_osm_local_elements_country_waterway ON osm_local_elements (country, (tags ->> 'waterway'));
ALTER TABLE osm_local_elements ENABLE ROW LEVEL SECURITY;
