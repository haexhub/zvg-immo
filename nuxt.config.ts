import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-04-01',
  devtools: { enabled: true },
  ssr: true,
  modules: ['@nuxtjs/i18n', 'shadcn-nuxt', '@nuxt/eslint'],
  css: ['~/assets/css/tailwind.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  shadcn: {
    prefix: '',
    componentDir: '~/components/ui',
  },
  i18n: {
    baseUrl: 'https://zvg.haex.cloud',
    langDir: 'locales',
    locales: [
      { code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
    defaultLocale: 'de',
    // No URL prefix — locale is a cross-cutting preference (cookie/account),
    // not a routable resource. Keeps every existing route/link unchanged.
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'zvg_locale',
      // Persists the switcher choice; overridden after login by the account
      // preference sync in composables/useLocalePreference.ts.
      alwaysRedirect: false,
    },
  },
  app: {
    head: {
      // Locale-aware title/description are set reactively in app.vue via
      // useHead() (i18n's 'site.*' keys) — only the locale-independent meta
      // stays here.
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  runtimeConfig: {
    // LLM fallback for the enrich task. Disabled when baseUrl is empty
    // (rules-only). Default provider is 'openai-compatible' — most backends
    // (OpenAI, Kimi/Moonshot, DeepSeek, Groq, Gemini via its OpenAI-compat
    // layer) speak the same wire format, so switching is a baseUrl/apiKey/
    // model env-var change, not a deploy of new code. Override per env:
    //   NUXT_EXTRACT_LLM_PROVIDER=openai-compatible
    //   NUXT_EXTRACT_LLM_BASE_URL=https://api.moonshot.ai/v1
    //   NUXT_EXTRACT_LLM_API_KEY=...
    //   NUXT_EXTRACT_LLM_MODEL=kimi-k3
    // 'claude-proxy' remains available (Anthropic-Messages-Format, via
    // haex-claude-proxy) as the transitional path:
    //   NUXT_EXTRACT_LLM_PROVIDER=claude-proxy
    //   NUXT_EXTRACT_LLM_BASE_URL=http://haex-claude-proxy:8080
    //   NUXT_EXTRACT_LLM_API_KEY=<optional proxy resolver token; required for api_key-backed Anthropic Batch>
    //   NUXT_EXTRACT_LLM_MODEL=claude-haiku-4-5
    // 'gemini-native' opts into Gemini's own API (not its OpenAI-compat layer)
    // for its one genuine extra capability, native PDF understanding — reads
    // scanned Gutachten correctly without a rasterize/OCR step:
    //   NUXT_EXTRACT_LLM_PROVIDER=gemini-native
    //   NUXT_EXTRACT_LLM_BASE_URL=https://generativelanguage.googleapis.com
    //   NUXT_EXTRACT_LLM_API_KEY=...
    //   NUXT_EXTRACT_LLM_MODEL=gemini-flash-latest (NOT gemini-2.5-flash — 404s for new keys)
    extractLlm: {
      provider: '',
      baseUrl: '',
      apiKey: '',
      model: 'claude-haiku-4-5',
      // Overrides enrich.ts's MAX_LLM_PER_RUN default (300). Meant to be
      // bumped temporarily while only one country is being crawled (see
      // server/crawlers/registry.ts's ENABLED_COUNTRIES) to clear its backlog
      // in a handful of runs instead of trickling in over weeks, then lowered
      // again once more countries are re-enabled and share the budget.
      //   NUXT_EXTRACT_LLM_MAX_PER_RUN=2000
      maxPerRun: '',
      // Gemini Batch safety rail. The Gemini API doesn't expose a reliable
      // "am I Free/Paid Tier?" endpoint to API-key callers; AI Studio remains
      // the source of truth for the active tier/limits. Fail closed to "free"
      // and make paid/budgeted operation explicit later.
      //   NUXT_EXTRACT_LLM_GEMINI_BATCH_TIER=free|paid
      // Free defaults below intentionally fit under the AI Studio Free Tier
      // shape seen during setup (e.g. small RPD/RPM buckets): one mini-batch
      // per UTC day, with token/item caps so a full-country reprocess cannot
      // burn the day in one submission.
      //   NUXT_EXTRACT_LLM_GEMINI_FREE_BATCH_MAX_JOBS_PER_DAY=1
      //   NUXT_EXTRACT_LLM_GEMINI_FREE_BATCH_MAX_ITEMS=5
      //   NUXT_EXTRACT_LLM_GEMINI_FREE_BATCH_MAX_ESTIMATED_TOKENS=100000
      //   NUXT_EXTRACT_LLM_GEMINI_FREE_BATCH_POLL_INTERVAL_HOURS=6
      // Paid stays faster by default, but still bounded to keep one accidental
      // manual run from producing a monster JSONL job before proper budgets land.
      //   NUXT_EXTRACT_LLM_GEMINI_PAID_BATCH_MAX_ITEMS=300
      geminiBatchTier: 'free',
      geminiFreeBatchMaxJobsPerDay: 1,
      geminiFreeBatchMaxItems: 5,
      geminiFreeBatchMaxEstimatedTokens: 100_000,
      geminiFreeBatchPollIntervalHours: 6,
      geminiPaidBatchMaxItems: 300,
    },
    // Sibling haex-claude-proxy container's own address — always deployed
    // regardless of which provider extractLlm.baseUrl currently points at
    // (e.g. gemini-native). Used only for the /settings OAuth setup flow
    // (server/utils/claude-proxy.ts), so it must NOT be derived from
    // extractLlm.baseUrl, which switches with the active extraction provider.
    //   NUXT_CLAUDE_PROXY_URL=http://haex-claude-proxy:8080
    claudeProxyUrl: '',
    // Bearer token that authenticates zvg-immo against haex-claude-proxy's
    // /setup/* endpoints. Same value must be set on both containers.
    //   NUXT_PROXY_SETUP_TOKEN=<openssl rand -hex 32>
    proxySetupToken: '',
    // Password protecting the /settings page — solo-deployment scope, no user
    // db. HMAC secret signs the session cookie.
    //   NUXT_SETTINGS_PASSWORD=<user-chosen>
    //   NUXT_SETTINGS_SESSION_SECRET=<openssl rand -hex 32>
    settingsPassword: '',
    settingsSessionSecret: '',
    // Set to '1' when this app runs behind a trusted reverse proxy (e.g.
    // Traefik in the sibling compose service) that overwrites
    // x-forwarded-for. Off by default so a directly-exposed instance can't
    // have its rate-limit buckets rotated by a spoofed header.
    //   NUXT_TRUST_FORWARDED_FOR=1
    trustForwardedFor: '',
    // Direct `pg` connection to the self-hosted Supabase `db` service, used
    // by server/utils/db.ts to run server/db/schema.sql on boot. Empty →
    // migrations are skipped (see db.ts) rather than failing hard.
    //   NUXT_DATABASE_URL=postgres://postgres:<pw>@db:5432/postgres
    databaseUrl: '',
    // External market/risk datasets are ingested out-of-band into local or
    // Postgres-backed caches; detail pages only read location_enrichment.
    // Empty values keep the external-enrichment task inert unless overridden
    // from /settings's "Externe Datenquellen" card (server/utils/external-
    // data/config.ts — DB override > this env default > sources.ts's field
    // default), the same env/DB precedence server/utils/app-settings.ts's
    // LLM provider override already uses.
    //   NUXT_EXTERNAL_DATA_FR_DVF_CACHE_PATH=/app/.cache_zvg/external/fr-dvf.json
    //   NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_GEO_JSON_PATH=/app/.cache_zvg/external/eu-flood-risk.geojson
    //   NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS=400
    //   NUXT_EXTERNAL_DATA_EEA_NOISE_SERVICE_BASE_URL=https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap
    //   NUXT_EXTERNAL_DATA_COPERNICUS_EFFIS_CACHE_PATH=/app/.cache_zvg/external/copernicus-effis.json
    //   NUXT_EXTERNAL_DATA_COPERNICUS_EFFIS_MAX_CACHE_AGE_DAYS=400
    externalData: {
      frDvfCachePath: '',
      euFloodRiskGeoJsonPath: '',
      euFloodRiskMaxCacheAgeDays: 400,
      eeaNoiseServiceBaseUrl: '',
      eeaNoiseTimeoutMs: 10_000,
      // Public, unauthenticated API, so unlike the entries above this one
      // carries a working default and needs no deployment config.
      camsAirQualityServiceUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      camsAirQualityTimeoutMs: 10_000,
      copernicusEffisCachePath: '',
      copernicusEffisMaxCacheAgeDays: 400,
    },
    // G1 Roh-Archiv (WP-3): Supabase Storage bucket for archived crawl
    // snapshots (server/utils/raw-archive.ts, storage-uploader.ts). Empty →
    // archiving stays local-only (blobs pile up in the outbox, nothing
    // uploads) — same graceful-degrade pattern as extractLlm.baseUrl above.
    // Uploads via the same service-role client as supabaseUrl/
    // supabaseServiceRoleKey below (server/utils/supabase.ts). Also requires
    // databaseUrl (the raw_blobs/raw_captures index lives in Postgres, see
    // server/db/schema.sql).
    //   NUXT_STORAGE_BUCKET=zvg-immo-raw-archive
    storageBucket: '',
    // WP-4: Supabase Storage bucket for extracted auction photos (public-read;
    // server/utils/image-storage.ts). Separate from storageBucket above — a
    // different lifecycle (photos can be re-extracted/replaced, the raw
    // archive is immutable). Empty → /api/auction-image serves only from the
    // local cache (.cache_zvg/images), same graceful-degrade pattern.
    //   NUXT_IMAGES_BUCKET=zvg-immo-images
    imagesBucket: '',
    // Local outbox for not-yet-uploaded archive blobs (docker-compose.yml
    // volume). Empty → defaults to .cache_zvg-style local dir under cwd.
    //   NUXT_RAW_OUTBOX_DIR=/app/.raw_outbox
    rawOutboxDir: '',
    // Internal Kong URL + service-role key for server/utils/supabase.ts
    // (getServiceClient()/getUserFromEvent()) — used by the saved-searches/
    // watchlist API routes. Server-only, unlike public.supabaseUrl below
    // (which the browser uses to talk to GoTrue directly).
    //   NUXT_SUPABASE_URL=http://kong:8000
    supabaseUrl: '',
    //   NUXT_SUPABASE_SERVICE_ROLE_KEY=<from scripts/generate-supabase-keys.mjs>
    supabaseServiceRoleKey: '',
    // App-level mailer for alert emails (server/utils/mailer.ts, nodemailer
    // over this connection string), used by server/utils/alert-matching.ts.
    // Distinct from GoTrue's own separate SMTP config (docker-compose.yml's
    // `auth` service, GOTRUE_SMTP_*) for GoTrue's own transactional mail.
    // Empty → sendMail() logs instead of sending (dev fallback, same
    // graceful-degrade pattern as extractLlm.baseUrl).
    //   NUXT_SMTP_URL=smtps://user:pass@smtp.example.com:465
    smtpUrl: '',
    public: {
      // Browser-side Supabase Auth (GoTrue via Kong). Empty → useAuth()'s
      // client is never created and the login/signup pages show a
      // "not configured" state instead of throwing.
      //   NUXT_PUBLIC_SUPABASE_URL=http://localhost:8000
      supabaseUrl: '',
      //   NUXT_PUBLIC_SUPABASE_ANON_KEY=<from scripts/generate-supabase-keys.mjs>
      supabaseAnonKey: '',
      // Optional browser-side map tiles. When empty,
      // maps fall back to OpenStreetMap/Esri tiles, whose raster labels are
      // provider-defined and cannot be switched per UI locale.
      //   NUXT_PUBLIC_MAPTILER_API_KEY=<from MapTiler Cloud>
      maptilerApiKey: '',
      // MapTiler style IDs, rendered as vector tiles (lib/map-tiles.ts +
      // ol-mapbox-style) with labels re-localized to the current UI locale at
      // runtime — one style per mode covers every locale, unlike the old
      // raster tiles this replaced (label language was baked into the style,
      // needing a separate Map ID per language).
      maptilerStreetsMapId: '',
      maptilerSatelliteMapId: '',
    },
  },
  nitro: {
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      // Every 6 hours: re-crawl and fill in missing geocodes. After the first
      // bulk run the cache is hot; subsequent ticks finish in seconds.
      '0 */6 * * *': ['geocode'],
      // Offset 30 min from geocode so the two full crawls don't overlap. Crawls,
      // fetches detail pages, and downloads/archives documents + photos for new
      // or changed listings — no extraction here (see 'reprocess' below), so
      // this keeps making progress regardless of LLM availability/budget.
      '30 */6 * * *': ['enrich'],
      // Hourly: crawl regions due for a refresh and write the persistent list
      // cache so /api/auctions serves from disk instead of hitting upstream on
      // every call. The task self-throttles per portal (crawl-cadence.ts), so
      // robust portals refresh hourly while rate-limited ones stay on a longer
      // interval — an always-on background watch for new/updated auctions.
      '0 * * * *': ['refresh'],
      // Hourly, offset 15 min from refresh: runs regex rules + the LLM against
      // whatever 'enrich' has archived so far, scoped to the enabled admin
      // data sources — independent of enrich's own schedule (see
      // server/tasks/reprocess.ts). A stalled/rate-limited LLM only delays
      // this task, never crawling.
      '15 * * * *': ['reprocess'],
      // Every 30 minutes: check in-flight LLM Batch API jobs submitted by
      // explicit batch runs (see server/utils/extract/llm-batch.ts) and merge
      // completed results — jobs often finish well under the 24h SLA, so a
      // shorter tick than enrich's own 6h cadence gets results merged sooner.
      '*/30 * * * *': ['llm-batch-poll'],
      // Daily: refresh cached external market/risk/location overlays. Location
      // context (server/utils/external-data/osm-location-context.ts) reads a
      // local Postgres table loaded out-of-band by a standalone osm2pgsql job,
      // not a live external endpoint, so this stays a fast local-DB pass; the
      // remaining externalData adapters (market/hazard) are a cheap no-op
      // until configured.
      '15 3 * * *': ['external-enrichment'],
      // Monthly: refresh the local EU Flood Risk Areas polygon cache (see
      // server/tasks/import-eu-flood-risk-cache.ts) from the EEA's published
      // service, into whatever path the eu-flood-risk-areas source resolves to
      // — and stay inert while it has none, so this never paginates the whole
      // EU layer into a file no adapter opens. The Floods Directive reporting
      // cycle itself is six-yearly, so monthly is just a courtesy re-pull to
      // catch source corrections.
      '30 4 1 * *': ['import-eu-flood-risk-cache'],
      // Monthly, offset from the flood importer: refresh the local Copernicus
      // EFFIS MODIS burnt-area polygon cache (see server/tasks/import-
      // copernicus-effis-cache.ts) into whatever path the copernicus-effis
      // source resolves to — stays inert while unconfigured, same contract.
      // New fire seasons land in the source roughly annually, so monthly is
      // a courtesy re-pull, not a rate-limit concern.
      '0 5 1 * *': ['import-copernicus-effis-cache'],
      // Daily at a quiet hour: move ended auctions' cached photos into the
      // images bucket and drop the local copies (server/tasks/offload-images.ts).
      // The local image cache is by far the largest thing on the server volume,
      // and it only ever grows — every past auction keeps its photos forever.
      // Inert until NUXT_IMAGES_BUCKET is configured.
      '45 4 * * *': ['offload-images'],
    },
    routeRules: {
      // /api/auctions and /api/auctions-geo query Postgres per request and send
      // no-store themselves: their results depend on the full filter/pagination
      // query and, for the geo endpoint, on a geocode cache that grows while the
      // client polls — an SWR route rule would freeze geocodedCount after the
      // first hit.
      // /api/regions depends on the admin-enabled country scope and must
      // reflect changes immediately; that handler sends no-store.
      // WP-7: rate table refreshes at most every 24h anyway (exchange-rate.ts's
      // own TTL); swr avoids re-doing that disk-cache read on every request.
      '/api/exchange-rates': { swr: 86400 },
    },
  },
})
