import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const allScopesFreshWithin = vi.fn()
vi.mock('./crawl-state', () => ({ allScopesFreshWithin }))

const getTaskRunStatus = vi.fn()
vi.mock('./task-runs', () => ({ getTaskRunStatus }))

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

describe('taskStartedWithin', () => {
  const HOUR = 60 * 60 * 1000

  it('is true when the task started within the window', async () => {
    const { taskStartedWithin } = await import('./boot-crawl-gate')
    getTaskRunStatus.mockResolvedValue({ startedAt: new Date(Date.now() - HOUR).toISOString() })

    expect(await taskStartedWithin('enrich', 6 * HOUR, 'enrich-bootstrap')).toBe(true)
    expect(getTaskRunStatus).toHaveBeenCalledWith('enrich')
  })

  it('is false once the last start is older than the window', async () => {
    const { taskStartedWithin } = await import('./boot-crawl-gate')
    getTaskRunStatus.mockResolvedValue({ startedAt: new Date(Date.now() - 7 * HOUR).toISOString() })

    expect(await taskStartedWithin('enrich', 6 * HOUR, 'enrich-bootstrap')).toBe(false)
  })

  it('is false without a recorded or with an unparsable or future start', async () => {
    const { taskStartedWithin } = await import('./boot-crawl-gate')
    for (const startedAt of [null, 'not-a-date', new Date(Date.now() + HOUR).toISOString()]) {
      getTaskRunStatus.mockResolvedValue({ startedAt })
      expect(await taskStartedWithin('enrich', 6 * HOUR, 'enrich-bootstrap')).toBe(false)
    }
  })
})
