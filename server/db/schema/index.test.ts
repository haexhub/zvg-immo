import { describe, expect, it } from 'vitest'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './index'

const tables = Object.values(schema).filter((value): value is PgTable => value instanceof PgTable)

describe('RLS policies', () => {
  it('only let PostgREST roles read rows, never write them', () => {
    const policies = tables.flatMap((table) => {
      const config = getTableConfig(table)
      return config.policies.map(policy => ({ table: config.name, policy: policy.name, for: policy.for }))
    })

    expect(policies.map(p => p.table).sort()).toEqual([
      'alert_subscriptions',
      'api_keys',
      'lawyer_inquiries',
      'saved_searches',
      'watchlist_items',
    ])
    for (const policy of policies) {
      expect(policy, `${policy.table}.${policy.policy}`).toMatchObject({ for: 'select' })
    }
  })
})
