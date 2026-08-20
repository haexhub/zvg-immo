import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const allScopesFreshWithin = vi.fn()
vi.mock('./crawl-state', () => ({ allScopesFreshWithin }))

const ensureEnabledCountriesLoaded = vi.fn()
const listRegions = vi.fn()
vi.mock('../crawlers/registry', () => ({ ensureEnabledCountriesLoaded, listRegions }))

beforeEach(() => {
  allScopesFreshWithin.mockReset()
  ensureEnabledCountriesLoaded.mockReset().mockResolvedValue(undefined)
  listRegions.mockReset().mockReturnValue([
    { country: 'de', code: 'be', name: 'Berlin', platforms: [{ id: 'zvg-portal', name: 'ZVG-Portal' }] },
    {
      country: 'de',
      code: 'bw',
      name: 'Baden-Württemberg',
      platforms: [
        { id: 'zvg-portal', name: 'ZVG-Portal' },
        { id: 'zvbawu', name: 'zvbawü' },
      ],
    },
  ])
})
afterEach(() => vi.restoreAllMocks())

describe('shouldSkipBootCrawl', () => {
  it('flattens every registered region into its (country, region, platform) scopes', async () => {
    const { shouldSkipBootCrawl } = await import('./boot-crawl-gate')
    allScopesFreshWithin.mockResolvedValue(true)

    await shouldSkipBootCrawl('refresh-bootstrap')

    expect(ensureEnabledCountriesLoaded).toHaveBeenCalledOnce()
    const [scopes, maxAgeMs] = allScopesFreshWithin.mock.calls[0]!
    expect(scopes).toEqual([
      { country: 'de', region: 'be', platform: 'zvg-portal' },
      { country: 'de', region: 'bw', platform: 'zvg-portal' },
      { country: 'de', region: 'bw', platform: 'zvbawu' },
    ])
    expect(maxAgeMs).toBe(6 * 60 * 60 * 1000)
  })

  it('skips the boot crawl when every registered scope is fresh', async () => {
    const { shouldSkipBootCrawl } = await import('./boot-crawl-gate')
    allScopesFreshWithin.mockResolvedValue(true)

    expect(await shouldSkipBootCrawl('refresh-bootstrap')).toBe(true)
  })

  it('does not skip when any registered scope is missing or stale — a partial prior run must not look fully warm', async () => {
    const { shouldSkipBootCrawl } = await import('./boot-crawl-gate')
    allScopesFreshWithin.mockResolvedValue(false)

    expect(await shouldSkipBootCrawl('refresh-bootstrap')).toBe(false)
  })
})
