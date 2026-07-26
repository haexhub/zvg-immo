import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-04-01',
  devtools: { enabled: true },
  ssr: true,
  modules: ['@nuxtjs/i18n', 'shadcn-nuxt'],
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
    // Empty values keep the external-enrichment task inert.
    //   NUXT_EXTERNAL_DATA_FR_DVF_CACHE_PATH=/app/.cache_zvg/external/fr-dvf.json
    //   NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_GEO_JSON_PATH=/app/.cache_zvg/external/eu-flood-risk.geojson
    externalData: {
      frDvfCachePath: '',
      euFloodRiskGeoJsonPath: '',
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
      // Free, instant self-service keys for the per-country satellite
      // imagery layers in lib/countryImagery.ts that require one (Finland,
      // Denmark) — that country's layer just falls back to Esri until set.
      //   NUXT_PUBLIC_MML_API_KEY=<from omatili.maanmittauslaitos.fi>
      mmlApiKey: '',
      //   NUXT_PUBLIC_DATAFORDELER_API_KEY=<from datafordeler.dk>
      datafordelerApiKey: '',
      // Browser-side Supabase Auth (GoTrue via Kong). Empty → useAuth()'s
      // client is never created and the login/signup pages show a
      // "not configured" state instead of throwing.
      //   NUXT_PUBLIC_SUPABASE_URL=http://localhost:8000
      supabaseUrl: '',
      //   NUXT_PUBLIC_SUPABASE_ANON_KEY=<from scripts/generate-supabase-keys.mjs>
      supabaseAnonKey: '',
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
      // Offset 30 min from geocode so the two full crawls don't overlap. Fills
      // the extraction cache (property type + sizes) for new listings.
      '30 */6 * * *': ['enrich'],
      // Hourly: crawl regions due for a refresh and write the persistent list
      // cache so /api/auctions serves from disk instead of hitting upstream on
      // every call. The task self-throttles per portal (crawl-cadence.ts), so
      // robust portals refresh hourly while rate-limited ones stay on a longer
      // interval — an always-on background watch for new/updated auctions.
      '0 * * * *': ['refresh'],
      // Every 30 minutes: check in-flight LLM Batch API jobs submitted by
      // explicit batch runs (see server/utils/extract/llm-batch.ts) and merge
      // completed results — jobs often finish well under the 24h SLA, so a
      // shorter tick than enrich's own 6h cadence gets results merged sooner.
      '*/30 * * * *': ['llm-batch-poll'],
      // Daily: refresh cached external market/risk overlays. With no configured
      // externalData adapters this is a cheap no-op; detail pages never fetch
      // providers live.
      '15 3 * * *': ['external-enrichment'],
    },
    routeRules: {
      // /api/auctions caches inside the handler (defineCachedFunction) instead
      // of an SWR route rule: the route-rule cache would also pin the graceful
      // empty response a rate-limited crawl returns. The geo endpoint just
      // decorates with cached lookups, so it must not be cached independently —
      // that would freeze geocodedCount after the first hit.
      '/api/regions': { swr: 86400 },
      // WP-7: rate table refreshes at most every 24h anyway (exchange-rate.ts's
      // own TTL); swr avoids re-doing that disk-cache read on every request.
      '/api/exchange-rates': { swr: 86400 },
      // Landing-page stats only need to be as fresh as the hourly refresh task
      // above — swr avoids re-parsing every cached region file on each hit.
      '/api/stats': { swr: 3600 },
    },
  },
})
