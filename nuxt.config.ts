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
    },
    routeRules: {
      '/api/auctions': { swr: 1800 },
      '/api/auctions-geo': { swr: 3600 },
      '/api/bundeslaender': { swr: 86400 },
    },
  },
})
