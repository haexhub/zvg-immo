import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Nuxt resolves '~' and '@' to the project root. Mirror that here so unit tests
// can import shared modules ('~/lib/...') the same way the app does.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '~': root, '@': root, '~~': root, '@@': root },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
})
