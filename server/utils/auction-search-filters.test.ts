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
    expect(predicate).toContain(`d.extraction_source = 'llm'`)
  })

  it('lets an explicit llmOnly=0 override the admin default', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { llmOnly: '0' })

    expect(predicate).not.toContain(`d.extraction_source = 'llm'`)
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

  it('adds an osm_local_elements proximity clause for a set Umgebung filter', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, { nearSea: '5', llmOnly: '0' })

    expect(predicate).toContain('EXISTS')
    expect(predicate).toContain('osm_local_elements')
    expect(values).toContain('natural')
    expect(values).toContain('coastline')
    expect(values).toContain(5_000)
  })

  it('builds the sea filter broadly enough for Swedish coast and island searches', async () => {
    const { getEnabledCountryCodes } = await import('~/server/crawlers/registry')
    vi.mocked(getEnabledCountryCodes).mockReturnValueOnce(['de', 'at', 'se'])
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, { country: 'se', nearSea: '100', llmOnly: '0' })

    const seaPredicate = predicate.slice(predicate.indexOf('EXISTS'))
    expect(values[0]).toEqual(['se'])
    expect(seaPredicate).toContain(' OR ')
    expect(seaPredicate).not.toContain('o.country = a.country')
    expect(values).toEqual([
      ['se'],
      'natural',
      'coastline',
      'natural',
      'beach',
      'natural',
      'bay',
      'natural',
      'strait',
      'water',
      'sea',
      'water',
      'lagoon',
      'place',
      'sea',
      'place',
      'ocean',
      100_000,
    ])
  })

  it('keeps non-sea Umgebung filters scoped to the auction country', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, { nearLake: '20', llmOnly: '0' })

    expect(predicate).toContain('o.country = a.country')
    expect(values).toContain('natural')
    expect(values).toContain('water')
    expect(values).toContain(20_000)
  })

  it('ignores a zero or unset Umgebung distance', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { nearSea: '0', llmOnly: '0' })

    expect(predicate).not.toContain('osm_local_elements')
  })

  it('negates the place-proximity clause for a rural request', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, { urbanRural: 'rural', llmOnly: '0' })

    expect(predicate).toContain('NOT (')
    expect(values).toContain('place')
  })

  it('filters by geolocated distance once lat/lng/radius are all present', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate, values } = await buildAuctionSearchFilter(db, {
      nearLat: '52.5',
      nearLng: '13.4',
      nearRadius: '25',
      llmOnly: '0',
    })

    expect(predicate).toContain('ST_DWithin')
    // lat/lng live on auctions ("a"), not the versioned auction_details ("d")
    // — WP-0 moved them; a.lat/a.lng is a compile-time-invisible SQL string,
    // so nothing but a test catches a regression back to d.lat/d.lng.
    expect(predicate).toContain('a.lat')
    expect(predicate).toContain('a.lng')
    expect(predicate).not.toContain('d.lat')
    expect(predicate).not.toContain('d.lng')
    expect(values).toContain(52.5)
    expect(values).toContain(13.4)
    expect(values).toContain(25_000)
  })

  it('skips the geolocation filter when the radius is missing', async () => {
    const { buildAuctionSearchFilter } = await import('./auction-search-filters')
    const { predicate } = await buildAuctionSearchFilter(db, { nearLat: '52.5', nearLng: '13.4', llmOnly: '0' })

    expect(predicate).not.toContain('ST_DWithin')
  })
})
