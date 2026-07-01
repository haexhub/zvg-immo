import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-04-01',
  devtools: { enabled: true },
  ssr: true,
  css: ['~/assets/css/tailwind.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  app: {
    head: {
      title: 'Zwangsversteigerungen Deutschland',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'Öffentliche Immobilien-Zwangsversteigerungen aller deutschen Bundesländer, gecrawlt aus den amtlichen Justizportalen.',
        },
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
    },
    routeRules: {
      // The auctions list (HTML scraping) is the expensive part. The geo
      // endpoint just decorates with cached lookups, so it must not be cached
      // independently — that would freeze geocodedCount after the first hit.
      '/api/auctions': { swr: 1800 },
      '/api/regions': { swr: 86400 },
    },
  },
})
