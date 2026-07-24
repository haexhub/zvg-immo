// Public read-only mirror of /api/settings/display's admin-configured
// dashboard defaults — deliberately outside /api/settings/ (whose
// settings-auth middleware guards every path under that prefix) since
// pages/search.vue needs this default without an admin session.

import { getPool } from '~/server/utils/db'
import { DEFAULT_HIDE_RULES_ONLY_AUCTIONS, getHideRulesOnlyAuctions } from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const db = getPool()
  return {
    hideRulesOnlyAuctions: db ? await getHideRulesOnlyAuctions(db) : DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  }
})
