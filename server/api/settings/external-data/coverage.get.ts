// How far each configurable external-data source's rollout already reaches:
// per source, how many geocoded auctions already carry its data, overall and
// broken down by country. Admin-only via /api/settings/'s settings-auth
// guard.

import { getPool } from '~/server/utils/db'
import { computeExternalDataCoverage } from '~/server/utils/external-data/coverage'

export default defineEventHandler(async () => {
  const db = getPool()
  if (!db) return { sources: [] }
  return { sources: await computeExternalDataCoverage(db) }
})
