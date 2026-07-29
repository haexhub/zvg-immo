# EU-first market and natural-risk data source plan

Date: 2026-07-26
Scope: add external data sources for regional price comparison and location risk badges on auction detail pages.

## Goal

Every auction detail page should eventually answer two extra questions:

1. Is this object cheap or expensive compared with similar local residential properties?
2. Is the geocoded address inside or near relevant natural hazard zones such as flood, wildfire, avalanche or comparable nationally published hazards?

Use EU/Copernicus/EEA/Eurostat sources first where they are spatially and semantically useful. Fall back to national official sources when EU data is too coarse, missing, or legally unsuitable for offer-level display.

## Current repository context

- Detail pages read a decorated `AuctionDetail` from `server/api/auction/[platform]/[id].get.ts`.
- Enriched extracted facts live in `AuctionExtraction` (`types/auction.ts`) and are persisted via `extraction_cache` plus `auction_snapshot`.
- Coordinates are already resolved through `server/utils/geocode.ts` and surfaced as `lat`/`lng`.
- Scheduled background work already exists in `server/tasks/enrich.ts`, `server/tasks/geocode.ts`, `server/tasks/reprocess.ts` and related bootstrap plugins.
- UI cards should follow the existing `DetailSectionCard` pattern in `pages/objekt/[platform]/[id].vue`.

## Data model

Create a new external-enrichment layer instead of extending `AuctionExtraction` directly. Suggested shape:

```ts
export interface LocationEnrichment {
  platform: string
  externalId: string
  lat: number
  lng: number
  marketComparison?: MarketComparison | null
  hazards?: HazardAssessment[] | null
  checkedAt: string
  sources: DataSourceAttribution[]
}

export interface MarketComparison {
  pricePerSqm: number | null
  basis: 'livingArea' | 'landArea'
  areaSqm: number
  regionLabel: string
  propertyClass: 'house' | 'apartment' | 'land' | 'mixed' | 'unknown'
  medianPricePerSqm: number | null
  p25PricePerSqm: number | null
  p75PricePerSqm: number | null
  deltaPctVsMedian: number | null
  verdict: 'cheaper' | 'similar' | 'more_expensive' | 'insufficient_data'
  samples: number
  sources: DataSourceAttribution[]
}

export interface HazardAssessment {
  hazard: 'flood' | 'wildfire' | 'avalanche' | 'earthquake' | 'landslide' | 'storm' | 'hail' | 'snow_load'
  status: 'inside' | 'nearby' | 'outside' | 'unknown'
  severity: 'low' | 'medium' | 'high' | 'very_high' | 'unknown'
  distanceMeters: number | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}
```

Each contributing source must carry its own provenance (`id`, label, URL, license note, version, refresh cadence and checked timestamp). Combined enrichments should derive aggregate staleness from the stalest displayed child result, not from one global `sourceVersion` string.

Persist this separately from LLM extraction so source refresh cadence, licenses, confidence and stale data can be managed independently.

## Source strategy

### Market comparison

EU-level official data is useful for trend context, but generally too coarse for a listing-level "cheap/expensive in this town" judgement.

1. EU trend layer:
   - Eurostat House Price Index / housing price statistics. Use for country-level or quarterly trend adjustment, not local comparables.
   - ECB residential property prices. Use as macro context only, not object-level valuation.
   - Sources:
     - https://ec.europa.eu/eurostat/web/housing-price-statistics
     - https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Housing_price_statistics_-_house_price_index
     - https://data.ecb.europa.eu/data/data-categories/prices-macroeconomic-and-sectoral-statistics/other-prices-and-costs/property-prices/residential-property-prices

2. EU catalogue discovery:
   - data.europa.eu should be used as the first discovery index for national datasets, but not as the only ingestion endpoint.
   - Source: https://data.europa.eu/en

3. National official comparables, priority countries:
   - France: DVF / Demandes de valeurs foncières. Good first implementation because it exposes transaction prices, property facts and regular updates. Must respect anti-reidentification constraints.
     - https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres
     - https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees
   - United Kingdom / England & Wales if UK stays in scope for the app: HM Land Registry Price Paid Data. Good transaction source, but not EU. Treat as national fallback.
     - https://www.gov.uk/government/collections/price-paid-data
   - Germany: BORIS-D gives official land values, not residential sale comparables. Use it as a land-value and plausibility baseline; label it differently from transaction comparables.
     - https://www.bodenrichtwerte-boris.de/
   - For remaining EU countries, add a discovery spike per active crawler country. Prefer official statistical office, cadastral, tax authority, land registry, or national geodata APIs. Do not ingest commercial portal asking prices unless explicitly marked as asking-price data.

### Natural hazards

1. Floods:
   - EU Floods Directive requires member states to create/update flood hazard and flood risk maps. Use the EEA / Commission flood risk areas viewer and datasets as EU-first coverage.
   - EU layer is good for "potential significant flood risk area" and cross-country consistency. For parcel-like decisions, prefer national flood hazard maps where available.
   - Sources:
     - https://environment.ec.europa.eu/topics/water/floods_en
     - https://water.europa.eu/freshwater/resources/eu-flood-risk-areas-viewer
     - https://data.europa.eu/data/datasets/flood-risk-areas?locale=en

2. Wildfire / forest fire:
   - Use Copernicus EFFIS as EU-first. It provides current situation, wildfire risk, fire danger forecast layers, active fires, burnt areas and data services.
   - Use EFFIS for pan-European baseline and DWD/national indices where they provide finer national interpretation.
   - Sources:
     - https://effis.emergency.copernicus.eu/
     - https://forest-fire.emergency.copernicus.eu/applications/data-and-services
     - https://ewds.climate.copernicus.eu/datasets/cems-fire-historical-v1
     - Germany fallback: https://www.dwd.de/DE/leistungen/waldbrandgef/waldbrandgef.html

3. Avalanches:
   - There is no single EU parcel-level avalanche hazard layer suitable for every country. EAWS is useful for standard terminology, warnings and national service discovery.
   - Use national authoritative avalanche / torrent / hazard-zone maps in alpine countries. Austria HORA is a strong first fallback.
   - Sources:
     - https://www.avalanches.org/
     - Austria HORA: https://hora.gv.at/
     - Austrian natural hazards overview: https://www.bmluk.gv.at/en/topics/water/water-and-data-wisa/water-webgis.html

4. Other hazards:
   - Austria HORA can cover floods, avalanches, earthquakes, landslides, storms, lightning, hail and snow as a national pilot for multi-hazard UX.
   - For earthquake, landslide, hail and storm outside Austria, add country adapters only after confirming authoritative public APIs or downloadable geodata.

## Implementation plan

### WP1: Source registry and attribution

- Add `server/utils/external-data/sources.ts` with a typed registry:
  - source id, country coverage, hazard/market capability, URL, license note, refresh cadence, resolution, adapter function name.
- Add tests that assert every adapter has a source URL and display label.
- Verification:
  - `pnpm vitest run server/utils/external-data`
  - `pnpm exec nuxi typecheck`

### WP2: Storage and API overlay

- Add a `location_enrichment` persistence module mirroring the current snapshot/cache style.
- Key by `platform:externalId`; store JSON payload plus `checked_at`.
- Extend `server/api/auction/[platform]/[id].get.ts` to include optional `locationEnrichment`.
- Do not block detail pages on live external fetches. Only read cached enrichment.
- Verification:
  - Unit tests for read/write and detail endpoint overlay.
  - Existing auction detail endpoint tests if present, or add one.

### WP3: Market comparison v1

- Implement generic price-per-square-meter calculation server-side:
  - prefer living area for residential buildings/apartments
  - fall back to land area only when no living area is present
  - do not compare if market value or area is missing
- Implement France DVF adapter first:
  - query/download most recent files
  - preserve every source transaction as a distinct record with a stable source transaction ID, transaction date, commune, geohash and property class
  - compute p25/median/p75 and sample count for a radius or administrative unit in a separate aggregation step
  - enforce minimum sample count before producing verdict
- Implement Germany BORIS-D baseline as separate `land_value_baseline`, not as "comparable homes".
- UI: add "Preise in der Region" card only when `samples >= threshold` or when showing a clearly labelled land-value baseline.
- Verification:
  - Fixtures for DVF rows, geospatial bucketing, percentile calculation.
  - UI test or component-level snapshot for cheaper/similar/more-expensive states.

### WP4: Flood risk v1

- Implement EU Flood Risk Areas ingestion first:
  - ingest WFS/downloadable geometries into a local spatial-lite JSON/GeoJSON cache if no PostGIS is available
  - evaluate point-in-polygon and nearest distance
  - classify `inside` when the point is in a zone, `nearby` when the nearest edge distance is `> 0` and `<=` the adapter threshold in meters, and `outside` only when it is beyond that threshold; thresholds may be source-specific and must be boundary-tested just below, at and above the configured value
  - return status/severity/source attribution
- Add national override adapters for countries where EU layer is too coarse and official WMS/WFS/download endpoints are available.
- UI: add "Naturgefahren" card with source and checked date.
- Verification:
  - Point-in-polygon tests with small fixture polygons.
  - Detail endpoint overlays cached flood result.

### WP5: Wildfire and avalanche v1

- Wildfire:
  - Implement EFFIS layers as pan-European baseline.
  - Store both static wildfire risk and current forecast separately; current forecast should have a short TTL.
- Avalanche:
  - Add EAWS/national-service discovery metadata.
  - Implement Austria HORA or another active alpine country first if an accessible official endpoint is confirmed.
  - Mark unsupported countries as `unknown`, not `outside`.
- Verification:
  - TTL tests for current fire forecast.
  - UI states for unknown vs outside vs inside/nearby.

### WP6: Operational safeguards

- Add a scheduled `external-enrichment` task with per-provider rate limits and source-specific TTLs.
- Add admin/logging summary:
  - fetched items
  - skipped missing coordinates
  - provider failures
  - stale result count
- Every displayed result must show source label and a "not a substitute for official due diligence" disclaimer.

## UX rules

- Never show a hazard as "safe"; use "no known zone in selected source" or "outside known zone".
- Show `unknown` when the country/source is unsupported or stale.
- Always expose the source name and last checked date.
- For market comparison, never compare auction `Verkehrswert` to portal asking prices unless labelled as "asking-price benchmark".
- For sample-based comparisons, require a minimum sample size and display that sample count.

## Recommended order

1. WP1 + WP2 foundation.
2. WP3 France DVF pilot plus German BORIS-D baseline.
3. WP4 EU flood risk.
4. WP5 EFFIS wildfire, then national avalanche pilot.
5. Expand country adapters in the order of active crawler coverage and data availability.

## Implementation status

Updated: 2026-07-29

### 2026-07-29: why nothing was visible in production, and what fixed it

Everything below the 2026-07-27 heading was implemented and deployed, yet detail pages still showed
"Für diesen Standort liegen noch keine externen Standortdetails vor." and the map had no overlays.
Production ran the current `main`; there was no code regression. Four independent causes:

1. **The Overpass query could never complete** (PR #236). 48h of logs: 69 attempts, 0 successes
   (36 `fetch failed`, 14x 429, 10x timeout, 9x 504). Measured live against `overpass-api.de` for one
   Swedish auction: the query needed **60.6 s** of server-side execution as `around:` sub-queries
   versus **6.3 s** as bounding boxes (identical sub-queries, 1394 elements) — `around:` forces a
   linear scan, a bbox uses the spatial index. Critically, `osmContextTimeoutMs` is also emitted as
   the query's own `[timeout:]`, so the 20 s default made 504 the only possible outcome. Retries then
   consumed the per-IP slots (`/api/status` reports `Rate limit: 2`), producing the 429s, after which
   the endpoint refused us outright. Fixed by bbox selection, a 120 s default timeout, retry with
   backoff honouring `Retry-After`, a 2 s request gate, and a give-up counter after 5 consecutive
   failed auctions so a blocked endpoint cannot stretch the daily run into the next tick.
   `nearbyPlaces()` now clips to its radius explicitly, since a bbox is a superset of the circle and
   it is the one consumer with no metre threshold of its own.
2. **The noise data had no UI reader** (PR #237). `environment.reportedNoise` was written on every
   run and read by nothing — the environment card rendered only the OSM-derived road/aviation levels.
   So the noise layer would have stayed empty even after fix 1.
3. **Air quality did not exist at all** (PR #238), in any layer: no capability, no type, no registry
   entry, no adapter, no UI. Added end to end using the Copernicus CAMS European analysis via
   Open-Meteo's public keyless API (verified: 200 in 0.08 s, `european_aqi` plus PM10/PM2.5/NO2/ozone).
   Modelled as a `LocationContextEnhancer` like the EEA noise enricher, not a hazard adapter, because
   the hazard overlays draw a containment circle that would misrepresent a ~11 km grid average.
4. **The flood cache file was never imported.** `eu-flood-risk cache unusable at
   /app/.cache_zvg/external/eu-flood-risk.geojson: ENOENT`, so the hazard adapter was skipped on
   every run. The import task is monthly (`30 4 1 * *`), so it needs one manual trigger via
   `POST /api/settings/external-data/eu-flood-risk-cache` to become active before the 1st.

Config was **not** the remaining blocker: the `NUXT_EXTERNAL_DATA_*` env vars are set in production
and `app_settings` holds zero `external_data_config_*` rows, so the sources resolve through the env
fallback layer. "Configured according to the admin UI" did not mean "returning data".

Also fixed alongside, because it broke translation for every auction: the DB LLM profile assigned to
the `translation` scope had an empty API key, and `resolveLlmConfig(translationOverride ??
extractionOverride ?? llmCfg)` picks one object wholesale rather than merging per field, so the
working env key was never consulted. `gemini-native` sends `x-goog-api-key: ''`, which Google answers
with 403 `unregistered callers`. PR #235 rejects a keyless profile at save time for public endpoints
(internal sidecars stay legitimately keyless) and exposes `apiKeyMissing` so an already-broken
profile is visible rather than only guarded on the next write.

### WP5 avalanche: deliberately not implemented

EAWS publishes micro-region polygons whose features carry only a bare region id
(`{"id":"AD-01"}`, 16.4 MB). Containment would therefore mean "this area has an avalanche forecast" —
hundreds of km² including valley floors with no exposure — and `hazardColor` renders `inside` in red,
so every alpine property would be flagged. This matches WP5's own rule that unsupported sources must
yield `unknown`, never `outside`. Parcel-level avalanche risk requires national hazard zoning:
Géorisques (FR, PPRN) and HORA/Gefahrenzonenplan (AT). The registry already reflects this split —
`eaws` is `source_discovery` only, `at-hora` carries `hazard_avalanche`.

### Known gaps after 2026-07-29

- `overpass-api.de` is a shared community instance with 2 slots per IP. Fine at current volume;
  Europe-wide enrichment will want a self-hosted instance. The endpoint is admin-configurable, so
  that is a config change, not a code change.
- WP5 wildfire has a static historical signal only (see below), not a live current-danger forecast.

### 2026-07-29 (cont.): LLM failure observability + WP5 wildfire

1. **LLM provider request failures are now counted separately from empty results** (PR #240).
   `extractByLlm` used to map any provider request failure (network error, 403, 5xx) to the same
   `null` as an empty/unparseable response, so the reprocess status could report `N processed / N
   LLM calls` with zero visible errors while every call was failing. The three providers now report
   a genuine request failure via `onRequestError`, kept strictly apart from the rate-limit throw path
   (which must keep skipping without counting toward `llmFailures`). `reprocess.ts` tracks
   `llmErrors`/`lastLlmError` per run and surfaces both on the reprocess status cards in `/settings`.
2. **WP5 wildfire: Copernicus EFFIS MODIS Burnt Area, not the live Fire Weather Index forecast** (PR #243).
   Two EFFIS layers were investigated live against `maps.effis.emergency.copernicus.eu`:
   - `mf010.query` (MeteoFrance FWI forecast — the "current fire danger" layer this plan originally
     wanted): WMS GetFeatureInfo tested against several European points/dates (Stockholm, Marseille,
     Athens; 2022–2026) in `text/plain`, `text/html` and GML info formats. Every response was either
     empty or an unfilled HTML template (`[FWI]`/`[DANGER_RISK]` placeholders never substituted) — no
     resolved value was ever obtained. Treated as unverified and not shipped, the same standard this
     plan already applied to EAWS avalanche.
   - `modis.ba.poly` (JRC MODIS Burnt Area, 2016–present): verified live via WFS 1.1.0
     GetFeature/GML3 — real polygons with FIREDATE/COUNTRY/AREA_HA attributes.
     `outputformat=json`/`application/json` 502s on this MapServer instance for every typename
     tried; only GML3 output works. BBOX axis order follows the declared CRS (EPSG:4326 → lat,lng;
     CRS84 → lng,lat), confirmed by requesting the identical box both ways. `CQL_FILTER` is accepted
     but silently ignored — a country filter still returned other countries — so only BBOX actually
     scopes results.
   Implemented as a point-in-polygon hazard adapter mirroring `eu-flood-risk.ts`'s file-cache pattern
   exactly (reusing its `pointInPolygon`/`distanceToPolygonMeters`). This is a static/slowly-changing
   susceptibility signal — new fire seasons land in the source roughly annually — not the short-TTL
   forecast this plan envisioned; that gap is intentional, not an oversight, and is why the source's
   own registry label calls it out as "MODIS Burnt Area", not "fire danger". `high` severity reuses
   EFFIS's own public "large fire" (>500 ha) threshold from its annual reports; `medium`/`low` below
   that are this adapter's own bucketing (no EFFIS-documented boundary backs the split), and severity
   is `unknown` only when the matched zone carries no `AREA_HA`. No UI changes were needed: the
   "Naturgefahren" card and its icon/label/status/severity translations were already generic across
   every `HazardKind` since WP1/WP4, wildfire included.

### Earlier status

Updated: 2026-07-27

Completed in the current implementation branch:

- WP1 foundation:
  - Added `LocationEnrichment`, `MarketComparison`, `LandValueBaseline`, `HazardAssessment` and shared source-attribution types in `types/auction.ts`.
  - Added typed source registry in `server/utils/external-data/sources.ts` with EU, France, Germany and Austria source metadata.
  - Added tests that assert registered adapters have labels and source URLs.
- WP2 cache/API overlay:
  - Added Postgres-backed `location_enrichment` table in `server/db/schema.sql`.
  - Added `server/utils/external-data/location-enrichment.ts` mirroring the existing memoized Postgres cache style.
  - Extended `server/api/auction/[platform]/[id].get.ts` to return cached `locationEnrichment`.
  - Detail pages still never fetch external providers live.
- WP3 market pilot foundation:
  - Added server-side price-per-square-meter helpers in `server/utils/external-data/market.ts`.
  - Added France DVF normalization and comparison logic in `server/utils/external-data/fr-dvf.ts`:
    - local radius filtering
    - property-class filtering
    - p25 / median / p75
    - minimum sample threshold
    - cheaper / similar / more-expensive verdict
  - Added file-based DVF CSV import/cache path in `server/utils/external-data/fr-dvf-cache.ts`.
  - Added `import-fr-dvf-cache` Nitro task and protected settings endpoint:
    - `server/tasks/import-fr-dvf-cache.ts`
    - `POST /api/settings/external-data/fr-dvf-cache`
  - Added optional runtime config:
    - `NUXT_EXTERNAL_DATA_FR_DVF_CACHE_PATH=.cache_zvg/external/fr-dvf.json`
  - Added Germany BORIS-D land-value baseline model in `server/utils/external-data/de-boris.ts`; it is explicitly separate from residential comparable sales.
- Operational shell:
  - Added adapter-driven `external-enrichment` task in `server/tasks/external-enrichment.ts`.
  - Added protected manual run endpoint:
    - `POST /api/settings/external-data/enrichment`
  - Added daily scheduled task at `15 3 * * *`. With no configured adapters this is a cheap no-op.
  - Added provider failure, skipped-coordinate and written-result counts.
- WP4 flood-risk fixture-first foundation:
  - Added `server/utils/external-data/eu-flood-risk.ts` for local GeoJSON FeatureCollection ingestion/evaluation.
  - Added a small fixture cache at `server/utils/external-data/fixtures/eu-flood-risk-zones.fixture.geojson`.
  - Supports Polygon and MultiPolygon geometries, point-in-polygon checks, polygon holes and nearest edge distance.
  - Maps flood status to `inside`, `nearby`, `outside` or `unknown`; `outside` only means outside known zones in the selected source.
  - Reads severity from feature properties where possible and falls back to `unknown`.
  - Adds source label/source URL from the external source registry.
  - Added a default `external-enrichment` flood adapter that activates only when configured:
    - `NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_GEO_JSON_PATH=.cache_zvg/external/eu-flood-risk.geojson`
  - Detail pages still never fetch external hazard providers live; they only read cached `location_enrichment`.
- WP4 official EU Flood Risk Areas cache ingestion:
  - Verified the EEA Datahub source "Floods Reference Spatial Datasets reported under Floods Directive - version 3.0, Mar. 2025", published 2025-08-05.
  - The official dataset exposes a 1.4 GB Geopackage download plus ArcGIS REST/WMS services. The implementation uses the ArcGIS REST polygon layer because it supports GeoJSON, pagination and focused country imports:
    - `https://water.discomap.eea.europa.eu/arcgis/rest/services/FloodsDirective/FloodsRiskZone_WM/MapServer/2`
  - Added paginated ArcGIS REST import into the local GeoJSON cache:
    - `importEuFloodRiskGeoJsonCache(...)` in `server/utils/external-data/eu-flood-risk.ts`
  - Added Nitro task and protected settings endpoint:
    - `server/tasks/import-eu-flood-risk-cache.ts`
    - `POST /api/settings/external-data/eu-flood-risk-cache`
  - Cache files now carry top-level metadata (`sourceVersion`, `generatedAt`, source label/URL/service URL).
  - Added optional country-code filters for focused DE/FR/AT-style imports.
  - Added stale-cache handling: stale flood caches produce `unknown`, not `outside`.
  - Added `staleResults` to the external-enrichment summary.
  - Added optional runtime config:
    - `NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS=400`
- UI:
  - Added cached "Preise in der Region", "Bodenwert-Baseline" and "Naturgefahren" cards to `pages/objekt/[platform]/[id].vue`.
  - Cards always show source/check metadata and disclaimers. Hazards never use "safe" language.

Verification completed:

- `pnpm vitest run server/utils/external-data/eu-flood-risk.test.ts server/tasks/external-enrichment.test.ts server/tasks/import-eu-flood-risk-cache.test.ts server/api/settings/external-data/eu-flood-risk-cache.post.test.ts server/api/settings/external-data/enrichment.post.test.ts`
- `pnpm vitest run server/utils/external-data/eu-flood-risk.test.ts server/tasks/external-enrichment.test.ts`
- `pnpm vitest run server/utils/external-data server/tasks/external-enrichment.test.ts server/tasks/import-fr-dvf-cache.test.ts server/api/auction/[platform]/[id].get.test.ts server/api/settings/external-data`
- `pnpm exec nuxi typecheck`
- `pnpm test`

Next recommended prompt:

```text
Continue docs/plans/2026-07-26-eu-market-risk-data-sources-plan.md, section
"2026-07-29 (cont.): LLM failure observability + WP5 wildfire".

State: PRs #235-#240 merged, PR #243 (this session's wildfire work) open. LLM
failure observability is done. WP5 wildfire has a static MODIS burnt-area signal
only — read that section before touching EFFIS again, it records
why the live Fire Weather Index forecast (mf010.query) was investigated and
rejected as unverifiable, not skipped out of laziness.

Remaining candidates, roughly in priority order:
- Expand country adapters per "Recommended order" item 5 — pick the next country by
  actual crawler volume (check current_auctions row counts per country), not by
  guesswork.
- Open questions still unanswered: Postgres-only vs. disk-cache-for-local-dev,
  commercial asking-price APIs (allow labelled, or hide comparison?), PostGIS vs.
  the current lightweight GeoJSON/point-in-polygon approach as volume grows.
- If EFFIS's live FWI forecast becomes worth revisiting, it needs a different access
  path than the WMS GetFeatureInfo interface tested here — that one didn't return
  resolved values across multiple points/dates/formats in this session.

Constraints: new worktree + branch per independent task, one PR each, never merge
yourself, no Claude references in commits. Keep detail pages cache-only; no live
external fetch from the API route.
```

## Open questions

- Should the OSM Overpass endpoint move to a self-hosted instance? The public one allows 2 slots per
  IP, which bounds Europe-wide enrichment. Config-only change.
- Answered 2026-07-29: avalanche via EAWS is rejected as too coarse; parcel-level needs national
  sources (Géorisques FR, HORA AT).
- Should external data live in Postgres only, or also in a disk cache for local development without DB?
- Which countries are top priority after DE/FR/AT based on actual crawler volume?
- Should commercial asking-price APIs be allowed when no official national transaction data exists, or should the UI hide comparison instead?
- Do we want PostGIS, or keep a lightweight GeoJSON + point-in-polygon implementation until volume demands spatial indexes?
