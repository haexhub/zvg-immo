// @ts-check
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import withNuxt from './.nuxt/eslint.config.mjs'

// vue/no-undef-components only sees components explicitly imported in a
// file's own <script setup> — it has no idea Nuxt auto-registers everything
// under components/ globally, so without help it flags every single
// auto-imported tag as undefined. `nuxt prepare` (already a CI/typecheck
// prerequisite) writes the real, current auto-import registry to
// .nuxt/components.d.ts; reading it back in gives the rule an accurate
// allowlist instead of guessing. A component whose real registered name
// doesn't match what a template calls it (exactly the #261/#263 bug —
// AuctionDetailOverviewSections vs. the auto-generated
// ObjektAuctionDetailOverviewSections) won't appear here and stays flagged.
const componentsDts = readFileSync(
  fileURLToPath(new URL('./.nuxt/components.d.ts', import.meta.url)),
  'utf8',
)
const knownComponentNames = [...componentsDts.matchAll(/^export const (\w+):/gm)].map((m) => m[1])
const knownComponentPatterns = [
  ...knownComponentNames.map((name) => `^${name}$`),
  // Registered as Vue plugins (app.use(...)), not through Nuxt's component
  // auto-import scan, so they never appear in components.d.ts.
  '^ol-', // vue3-openlayers (components/Auction/Map.client.vue, DetailMap.client.vue)
  '^i18n-t$', // @nuxtjs/i18n's translation component
]

export default withNuxt(
  {
    rules: {
      // Catches exactly the class of bug that broke every auction detail
      // page in prod (#263): a template referencing a component name Nuxt's
      // auto-import never registered under.
      'vue/no-undef-components': ['error', { ignorePatterns: knownComponentPatterns }],

      // Pre-existing violations across the codebase from adopting @nuxt/eslint's
      // bundled rule set for the first time — out of scope for the
      // component-naming CI gate this config exists for. Left as 'off' rather
      // than fixed here to keep that fix a separate, reviewable change.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unified-signatures': 'off',
      '@typescript-eslint/no-import-type-side-effects': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'no-irregular-whitespace': 'off',
      'no-useless-assignment': 'off',
      'import/no-duplicates': 'off',
      'prefer-const': 'off',
      'no-control-regex': 'off',
      'import/first': 'off',
      'vue/require-default-prop': 'off',
    },
  },
)
