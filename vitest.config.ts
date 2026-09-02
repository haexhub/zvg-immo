import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

// Nuxt resolves '~' and '@' to the project root. Mirror that here so unit tests
// can import shared modules ('~/lib/...') the same way the app does.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '~': root, '@': root, '~~': root, '@@': root },
  },
  test: {
    include: ['**/*.test.ts'],
    // Nested agent worktrees contain their own copy of the test suite. They
    // are not part of this checkout and must not be discovered recursively.
    exclude: [...configDefaults.exclude, '.claude/**', '.claude-worktrees/**'],
    environment: 'node',
    testTimeout: 15_000,
  },
})
