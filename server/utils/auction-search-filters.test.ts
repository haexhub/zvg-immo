import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['de', 'at']),
  getEnabledCountryCodes: vi.fn(() => ['de', 'at']),
}))
vi.mock('~/server/utils/app-settings', () => ({
  getHideRulesOnlyAuctions: vi.fn(async () => true),
}))

const db = {} as Pool

afterEach(() => {
  vi.clearAllMocks()
})

describe('buildAuctionSearchFilter', () => {
  it('scopes an unfiltered search to the enabled countries', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, { llmOnly: '0' })

    expect(predicate).toContain('a.country = ANY($1::text[])')
    expect(values[0]).toEqual(['de', 'at'])
  })

  it('drops a requested country that the admin paused', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { values } = await buildAuctionSearchFilter(db, { country: 'de,se', llmOnly: '0' })

    // 'se' is paused: a permalink or saved search must not resurface it.
    expect(values[0]).toEqual(['de'])
  })

  it('yields an empty country scope when only paused countries are requested', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { values } = await buildAuctionSearchFilter(db, { country: 'se', llmOnly: '0' })

    expect(values[0]).toEqual([])
  })

  it('applies the admin hideRulesOnly default when llmOnly is absent from the query', async () => {
    const { getHideRulesOnlyAuctions } = await import('~/server/utils/app-settings')
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, {})

    expect(getHideRulesOnlyAuctions).toHaveBeenCalledWith(db)
    expect(predicate).toContain(`a.extraction_source = 'llm'`)
  })

  it('lets an explicit llmOnly=0 override the admin default', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { llmOnly: '0' })

    expect(predicate).not.toContain(`a.extraction_source = 'llm'`)
  })

  it('treats an empty numeric parameter as unset instead of 0', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { priceMin: '', llmOnly: '0' })

    expect(predicate).not.toContain('market_value_eur >=')
  })

  it('always excludes auctions whose date has passed', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { llmOnly: '0' })

    expect(predicate).toContain('a.auction_date_iso IS NULL OR a.auction_date_iso >= now()')
  })
})
