-- Idempotent bootstrap, run on every boot via runMigrations() (see
-- server/utils/db.ts). Phase 1 has nothing app-specific to create yet — this
-- just ensures pgcrypto is available for gen_random_uuid(), which every
-- later phase's uuid primary keys (saved_searches, watchlist_items, ...)
-- depend on. Later phases append their own CREATE TABLE blocks below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

-- WP-3: G1 Roh-Archiv Schicht 1. raw_blobs = deduplizierte Bytes (S3-Key =
-- content_hash, sha256), raw_captures = deduplizierter Capture-Index,
-- raw_document_sets = versionierte "diese Dokumente galten zusammen"-
-- Manifeste pro Auktion (server/utils/raw-archive.ts).
CREATE TABLE IF NOT EXISTS raw_blobs (
  content_hash  text PRIMARY KEY,          -- sha256 der kanonisierten Bytes
  s3_key        text NOT NULL,             -- sharded Key im Primary-Bucket, z.B. 'ab/abcd….json.gz'
  content_type  text NOT NULL,             -- 'application/json+gzip' | 'text/html+gzip' | 'application/pdf' | 'application/vnd.docx'
  byte_size     bigint NOT NULL,           -- Größe wie in der Outbox/S3 abgelegt (nach Kompression)
  first_seen_at timestamptz NOT NULL,
  uploaded_at   timestamptz                -- gesetzt, sobald Primary-Upload bestätigt (null = noch in Outbox)
);

CREATE TABLE IF NOT EXISTS raw_captures (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL,
  kind          text NOT NULL,             -- 'auction' | 'document' | 'detail_html' | 'document_text'
  platform      text NOT NULL,
  country       text NOT NULL,
  external_id   text NOT NULL,             -- Auktions-Identität (immer vorhanden)
  case_number   text,                      -- stabilere Cross-Run-Identität
  authority     text,
  content_hash  text NOT NULL REFERENCES raw_blobs(content_hash),
  source_url    text                       -- Upstream-URL (Provenienz)
);
CREATE INDEX IF NOT EXISTS idx_capt_identity_time ON raw_captures (platform, external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capt_az_time       ON raw_captures (authority, case_number, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capt_hash          ON raw_captures (content_hash);
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
      FROM raw_captures
    )
    DELETE FROM raw_captures rc USING ranked r
    WHERE rc.id = r.id AND r.rn > 1;

    INSERT INTO schema_migrations (name) VALUES ('raw_capture_dedupe_cleanup_20260727');
  END IF;
END $$;
-- The old uniqueness model keyed all captures by content_hash alone. The new
-- model deduplicates auction rows by identity+content_hash (append-only, a
-- new version per real change) and document rows by source URL+bytes.
DROP INDEX IF EXISTS idx_capt_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_capt_unique_auction_hash
  ON raw_captures (kind, platform, external_id, content_hash)
  WHERE kind = 'auction';
CREATE UNIQUE INDEX IF NOT EXISTS idx_capt_unique_source_hash
  ON raw_captures (kind, platform, external_id, (COALESCE(source_url, '')), content_hash)
  WHERE kind <> 'auction';

CREATE TABLE IF NOT EXISTS raw_document_sets (
  id              bigserial PRIMARY KEY,
  captured_at     timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  platform        text NOT NULL,
  country         text NOT NULL,
  region          text,
  external_id     text NOT NULL,
  case_number     text,
  authority       text,
  set_hash        text NOT NULL,
  version         integer NOT NULL,
  document_count  integer NOT NULL,
  UNIQUE (platform, external_id, set_hash),
  UNIQUE (platform, external_id, version)
);
CREATE INDEX IF NOT EXISTS idx_doc_sets_identity_version
  ON raw_document_sets (platform, external_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_doc_sets_country_region_time
  ON raw_document_sets (country, region, captured_at DESC);

CREATE TABLE IF NOT EXISTS raw_document_set_items (
  set_id        bigint NOT NULL REFERENCES raw_document_sets(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,
  kind          text NOT NULL,
  label         text,
  filename      text,
  file_id       text,
  source_url    text NOT NULL,
  content_hash  text NOT NULL REFERENCES raw_blobs(content_hash),
  content_type  text NOT NULL,
  PRIMARY KEY (set_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_doc_set_items_hash ON raw_document_set_items (content_hash);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'raw_blob_orphan_cleanup_20260727') THEN
    DELETE FROM raw_blobs rb
    WHERE NOT EXISTS (SELECT 1 FROM raw_captures rc WHERE rc.content_hash = rb.content_hash)
      AND NOT EXISTS (SELECT 1 FROM raw_document_set_items rdsi WHERE rdsi.content_hash = rb.content_hash);

    INSERT INTO schema_migrations (name) VALUES ('raw_blob_orphan_cleanup_20260727');
  END IF;
END $$;
-- Server-intern, nie clientseitig exponiert — trotzdem RLS aktivieren (ohne
-- Policies, also Default-Deny), sonst liest/schreibt PostgREST-anon/authenticated
-- munter mit; der Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE raw_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_document_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_document_set_items ENABLE ROW LEVEL SECURITY;

-- WP-8: i18n Baustein B (Content-Übersetzung). content_hash = sha256 über
-- {title, description, documentSummary, extractionTexts, documentSetHash,
--  documentSetVersion}
-- (raw-archive.ts's sha256Hex, siehe server/api/.../translation.post.ts):
-- unveränderter Inhalt/Dokumentstand -> Cache-Treffer, geänderter Inhalt oder
-- neue Dokumentversion -> neuer Hash -> neue Übersetzung. Immutabel pro
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
-- RLS ohne Policies (Default-Deny): sperrt PostgREST-anon/authenticated aus,
-- der Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE content_translations ENABLE ROW LEVEL SECURITY;

-- Datenqualitäts-Offensive: strukturierte "aktueller Zustand pro Auktion"-
-- Tabelle, additiv neben der bestehenden JSON-Snapshot-Pipeline
-- (auction-snapshot.ts). auction_observations (oben) ist ein Append-only-
-- Historienlog — kein Table, gegen das man "WHERE living_area_sqm BETWEEN …"
-- schnell filtern könnte, ohne jeden Lauf mitzuzählen. Diese Tabelle wird pro
-- Auktion upgeserted (server/utils/current-auctions.ts, aufgerufen aus
-- server/tasks/enrich.ts direkt neben writeAuctionSnapshot) und dient
-- zunächst als Parallel-Spiegel für schnelle SQL-Abfragen (Daten-API,
-- Admin-Tooling, künftige serverseitige Suche) — /api/auctions liest weiterhin
-- vom JSON-Snapshot, das umzustellen ist ein separater Folge-Schritt.
CREATE TABLE IF NOT EXISTS auctions (
  platform              text NOT NULL,
  external_id           text NOT NULL,
  country               text NOT NULL,
  region                text NOT NULL,
  authority             text NOT NULL,
  case_number           text NOT NULL,
  title                 text,
  address               text,
  description           text,
  property_type         text,
  land_area_sqm         numeric,
  living_area_sqm       numeric,
  rooms                 numeric,
  units                 integer,
  market_value          numeric,
  currency              text,
  market_value_eur      numeric,
  auction_date_iso      timestamptz,
  cancelled             boolean NOT NULL,
  -- photoCount/thumbnailUrl (not a raw photoUrls array) mirror the fields
  -- lib/auction-filters.ts's onlyWithPhotos filter actually checks today.
  photo_count           integer NOT NULL DEFAULT 0,
  thumbnail_url         text,
  lat                   numeric,
  lng                   numeric,
  detail_fetched_at     timestamptz,
  extraction_source     text,
  extraction_confidence text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_auctions_country_region ON auctions (country, region);
CREATE INDEX IF NOT EXISTS idx_auctions_property_type ON auctions (property_type);
CREATE INDEX IF NOT EXISTS idx_auctions_living_area ON auctions (living_area_sqm);
CREATE INDEX IF NOT EXISTS idx_auctions_land_area ON auctions (land_area_sqm);
-- Server-intern befüllt (öffentliche Lese-APIs bleiben vorerst auf dem
-- JSON-Snapshot) — RLS trotzdem an, ohne Policies (Default-Deny), sonst
-- läse/schriebe PostgREST-anon/authenticated direkt mit.
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;

-- WP-3: Zustand/Ausstattung (WP-1) + Preis-/Gebotsfelder (WP-2) additiv in den
-- bestehenden Filter-Spiegel aufgenommen. ADD COLUMN IF NOT EXISTS statt die
-- CREATE TABLE-Spaltenliste zu erweitern, da runMigrations() dieses schema.sql
-- bei jedem Boot komplett ausführt und CREATE TABLE IF NOT EXISTS in einer
-- bereits existierenden Prod-Tabelle keine Spalten nachträgt.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS condition jsonb;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS features text[];
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS starting_bid numeric;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS current_bid numeric;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS source_security_deposit numeric;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS security_deposit numeric;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS bidding_notes text;

-- WP-C.4: Baujahr/Sanierungsjahr in den Filter-Spiegel aufgenommen (eigene
-- Spalten, da als SQL-Filterkriterium sinnvoll). renovationNotes/insights/
-- photos bleiben bewusst nur im extraction_cache-JSONB — kein Filterbedarf,
-- kein eigenes Spaltenschema. Additiv, wie die WP-3-Spalten oben.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS year_built integer;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS last_renovation_year integer;
CREATE INDEX IF NOT EXISTS idx_auctions_year_built ON auctions (year_built);

-- WP-3: vollständiger Extraktions-Cache-Blob (server/utils/extraction-cache.ts)
-- — Postgres ist die einzige Persistenz, kein lokales JSON-File mehr. Eigene
-- Tabelle statt einer weiteren Spalte auf `auctions`: writeExtractionCache()
-- kennt nur platform+externalId+die AuctionExtraction, nicht das volle
-- Auction-Objekt mit den NOT-NULL-Feldern (country/region/authority/
-- case_number), die ein Insert in `auctions` bräuchte. Erstschreiber gewinnt
-- — kein TTL, keine Historie nötig.
CREATE TABLE IF NOT EXISTS extraction_cache (
  platform      text NOT NULL,
  external_id   text NOT NULL,
  extraction    jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
-- RLS ohne Policies (Default-Deny): sperrt PostgREST-anon/authenticated aus,
-- der Backend-Zugriff läuft als Table-Owner und umgeht RLS ohnehin.
ALTER TABLE extraction_cache ENABLE ROW LEVEL SECURITY;

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

-- auction_snapshot: ein vollständiger Auction-Blob pro (platform, external_id),
-- analog extraction_cache — trägt mergePreservedDetail's Merge-Semantik über
-- mehrere enrich-Läufe hinweg 1:1 weiter (die Funktion selbst ist unverändert,
-- nur die Persistenz darunter wechselt). Geschrieben von enrich.ts genau dort,
-- wo bisher writeAuctionSnapshot(result.auctions) lief.
CREATE TABLE IF NOT EXISTS auction_snapshot (
  platform      text NOT NULL,
  external_id   text NOT NULL,
  auction       jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
ALTER TABLE auction_snapshot ENABLE ROW LEVEL SECURITY;

-- External market/hazard enrichment is intentionally stored outside the LLM
-- extraction cache: provider licenses, TTLs and source versions have their
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

-- Roh-Archiv-Fix: region wurde bisher nicht auf raw_captures gespeichert,
-- sondern beim Lesen (regions.get.ts/cases.get.ts) live gegen die auctions-
-- Tabelle gejoint. Da auctions bei jedem enrich-Lauf komplett neu geschrieben
-- wird (current-auctions.ts) und ein einzelner fehlgeschlagener Upsert-Chunk
-- den Rest des Laufs stillschweigend abbricht, konnte ein ganzes Bundesland
-- im Archiv-Browser unter "—" verschwinden, obwohl raw_captures dafür Daten
-- hat. Ab jetzt wird region direkt beim Capture geschrieben (raw-archive.ts),
-- unabhängig vom aktuellen Zustand von auctions.
ALTER TABLE raw_captures ADD COLUMN IF NOT EXISTS region text;
CREATE INDEX IF NOT EXISTS idx_capt_country_region_time ON raw_captures (country, region, captured_at DESC);
-- Backfill für Bestandszeilen (region ist erst mit obigem ADD COLUMN
-- entstanden, ältere Zeilen haben region=NULL). Nur IS NULL, läuft bei jedem
-- Boot erneut (idempotent) und holt automatisch nach, sobald auctions für ein
-- bislang fehlendes Bundesland wieder befüllt ist.
UPDATE raw_captures rc SET region = a.region
FROM auctions a
WHERE rc.region IS NULL AND rc.platform = a.platform AND rc.external_id = a.external_id;

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
