import { describe, expect, it, vi } from 'vitest'
import { ALL_SCOPE } from '~/lib/auction-constants'
import { listCountries, listRegisteredCountries } from '../crawlers/registry'

vi.mock('../utils/db', () => ({ getPool: vi.fn(() => null) }))

const { applyPickerRegions, readStoredRegionNames } = await import('../utils/region-picker')
const { getPool } = await import('../utils/db')

/** The endpoint is a thin wrapper around listCountries() plus this projection;
 *  it is tested through the projection because importing the route itself
 *  would need Nitro's auto-imported defineEventHandler. */
function served(stored: Map<string, string[]> = new Map()) {
  return applyPickerRegions(listRegisteredCountries(), stored)
}

describe('/api/regions region projection', () => {
  it('drops the whole-country pseudo-region a nationwide-only platform registers', () => {
    expect(served().flatMap((c) => c.regions).some((r) => r.code === ALL_SCOPE)).toBe(false)
    // Bulgaria's sole region entry is exactly such a pseudo-region — it stays
    // selectable as a country, it just no longer offers a region that could
    // never match a row.
    expect(served().find((c) => c.code === 'bg')?.regions).toEqual([])
  })

  it('keeps real sub-regions, including a country covered by a single real one', () => {
    // Canada is served for Ontario only, but 'on' is a genuine province code
    // that the crawler also writes to Auction.region, so it must survive.
    expect(served().find((c) => c.code === 'ca')?.regions.map((r) => r.name)).toEqual(['Ontario'])
    expect(served().find((c) => c.code === 'de')?.regions.map((r) => r.name)).toContain('Sachsen')
    expect(served().find((c) => c.code === 'se')?.regions.map((r) => r.name)).toContain('Stockholm')
  })

  it('offers a nationwide-only country the region names its auctions actually carry', () => {
    const regions = served(new Map([['bg', ['Burgas', 'Pleven']]])).find((c) => c.code === 'bg')?.regions

    expect(regions?.map((r) => r.name)).toEqual(['Burgas', 'Pleven'])
    // The name is the key: useAuctionSearchState resolves `country:code` to
    // `country:name` before the SQL filter compares it against a.region.
    expect(regions?.map((r) => r.code)).toEqual(['Burgas', 'Pleven'])
    expect(regions?.every((r) => r.country === 'bg')).toBe(true)
    // The platforms serving the whole country serve each of its regions.
    expect(regions?.[0]?.platforms.map((p) => p.id)).toEqual(['bg-zapori'])
  })

  it('leaves a country with real sub-regions untouched by stored names', () => {
    const regions = served(new Map([['de', ['Made Up']]])).find((c) => c.code === 'de')?.regions

    expect(regions?.map((r) => r.name)).not.toContain('Made Up')
    expect(regions?.map((r) => r.name)).toContain('Sachsen')
  })

  it('leaves the registry itself untouched — the projection is API-only', () => {
    // listRegions()/listCountries() drive crawl scheduling and the admin
    // catalog, where the "all" entry is what tells the scheduler to crawl a
    // nationwide-only platform at all. Only the search/landing payload drops it.
    expect(listRegisteredCountries().flatMap((c) => c.regions).some((r) => r.code === ALL_SCOPE)).toBe(true)
    // Germany has no such entry to begin with: every platform serving it,
    // BImA included, registers real Bundesländer.
    expect(listCountries().find((c) => c.code === 'de')?.regions.some((r) => r.code === ALL_SCOPE)).toBe(false)
  })
})

describe('readStoredRegionNames', () => {
  it('groups the distinct region names per country', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: [
        { country: 'bg', region: 'Burgas' },
        { country: 'bg', region: 'Pleven' },
        { country: 'pl', region: 'Mazowieckie' },
      ],
    }))
    vi.mocked(getPool).mockReturnValueOnce({ query } as never)

    expect(await readStoredRegionNames(['bg', 'pl'])).toEqual(
      new Map([
        ['bg', ['Burgas', 'Pleven']],
        ['pl', ['Mazowieckie']],
      ]),
    )
    expect(query.mock.calls[0]?.[1]).toEqual([['bg', 'pl']])
  })

  it('stays empty without Postgres, which keeps the payload as it was', async () => {
    expect(await readStoredRegionNames(['bg'])).toEqual(new Map())
  })

  it('does not query at all when every country has real sub-regions', async () => {
    const query = vi.fn()
    vi.mocked(getPool).mockReturnValueOnce({ query } as never)

    expect(await readStoredRegionNames([])).toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })
})
