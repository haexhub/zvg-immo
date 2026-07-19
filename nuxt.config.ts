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
    },
  },
  runtimeConfig: {
    // LLM fallback for the enrich task, via haex-claude-proxy. Disabled when
    // baseUrl is empty (rules-only). Override per env:
    //   NUXT_EXTRACT_LLM_BASE_URL=http://haex-claude-proxy:8080
    //   NUXT_EXTRACT_LLM_MODEL=claude-haiku-4-5
    extractLlm: {
      baseUrl: '',
      model: 'claude-haiku-4-5',
    },
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
    // G1 Roh-Archiv (WP-3): S3-compatible primary bucket for archived crawl
    // snapshots (server/utils/raw-archive.ts, s3-uploader.ts). Empty →
    // archiving stays local-only (blobs pile up in the outbox, nothing
    // uploads) — same graceful-degrade pattern as extractLlm.baseUrl above.
    // Also requires databaseUrl (the raw_blobs/raw_captures index lives in
    // Postgres, see server/db/schema.sql).
    s3: {
      //   NUXT_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
      endpoint: '',
      //   NUXT_S3_BUCKET=zvg-immo-raw-archive
      bucket: '',
      //   NUXT_S3_ACCESS_KEY=...
      accessKey: '',
      //   NUXT_S3_SECRET_KEY=...
      secretKey: '',
      // Some S3-compatible providers ignore this; pass anything non-empty.
      //   NUXT_S3_REGION=eu-central-003
      region: '',
    },
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
    },
  },
})
