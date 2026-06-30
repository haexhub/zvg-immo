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
