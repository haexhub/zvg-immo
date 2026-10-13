import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { alertSubscriptions, apiKeys, savedSearches, watchlistItems } from './access'
import { lawyerInquiries } from './lawyers'

describe('user-owned table RLS', () => {
  // PostgREST is reachable with the anon key; any write policy would let a
  // signed-in user bypass the Nuxt routes' validation.
  it.each([
    ['saved_searches', savedSearches],
    ['watchlist_items', watchlistItems],
    ['alert_subscriptions', alertSubscriptions],
    ['api_keys', apiKeys],
    ['lawyer_inquiries', lawyerInquiries],
  ])('%s only grants PostgREST roles read access to own rows', (_name, table) => {
    const { enableRLS, policies } = getTableConfig(table)
    expect(enableRLS).toBe(true)
    expect(policies.map((policy) => policy.for)).toEqual(['select'])
    expect(policies.every((policy) => policy.withCheck === undefined)).toBe(true)
  })
})
