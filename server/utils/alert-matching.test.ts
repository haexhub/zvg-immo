import { afterEach, describe, expect, it, vi } from 'vitest'

const { getServiceClient, enqueueAlertDelivery } = vi.hoisted(() => ({
  getServiceClient: vi.fn(),
  enqueueAlertDelivery: vi.fn(),
}))

vi.mock('./supabase', () => ({ getServiceClient }))
vi.mock('./outbound-delivery', () => ({ enqueueAlertDelivery }))

// toAuctionFilters resolves `${countryCode}:${regionCode}` pairs to
// `${countryCode}:${regionDisplayName}` via listCountries() — stub the
// registry with a small fixture instead of depending on the full, ever-
// growing list of real crawlers.
vi.mock('../crawlers/registry', () => ({
  listCountries: () => [
    {
      code: 'de',
      name: 'Deutschland',
      regions: [{ code: 'sn', name: 'Sachsen', platforms: [] }],
    },
  ],
}))

const { toAuctionFilters, matchAlerts } = await import('./alert-matching')

const auction = {
  platform: 'portal', externalId: '42', title: 'Haus', authority: 'AG Test',
  caseNumber: '1 K 2/26', country: 'de', region: 'Sachsen', cancelled: false,
} as never

function alertSupabase(options: { email?: string, userError?: Error } = {}) {
  const inserted = vi.fn(async () => ({ error: null }))
  const notifiedSelect = {
    select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })),
    insert: inserted,
  }
  const client = {
    from: vi.fn((table: string) => table === 'alert_subscriptions'
      ? { select: vi.fn(() => ({ eq: vi.fn(async () => ({
        data: [{ id: 'sub-1', user_id: 'user-1', saved_searches: { filters: {} } }], error: null,
      })) })) }
      : notifiedSelect),
    auth: { admin: { getUserById: vi.fn(async () => ({
      data: { user: options.email ? { email: options.email } : null }, error: options.userError ?? null,
    })) } },
  }
  return { client, inserted }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('toAuctionFilters', () => {
  it('parses the stored query-param shape (saved_searches.filters) into AuctionFilters', () => {
    const filters = toAuctionFilters({
      country: 'de',
      region: 'de:sn',
      q: 'Wohnung',
      authority: 'AG Dresden',
      priceMin: '100000',
      priceMax: '',
      landMin: '500',
      category: 'einfamilienhaus',
      condition: 'gepflegt',
      features: 'balkon,garage',
      photos: '1',
      cancelled: '1',
      llmOnly: '1',
    })

    expect(filters.countries).toEqual(['de'])
    expect(filters.regionNameKeys).toEqual(new Set(['de:Sachsen']))
    expect(filters.search).toBe('Wohnung')
    expect(filters.authority).toBe('AG Dresden')
    expect(filters.category).toBe('einfamilienhaus')
    expect(filters.condition).toBe('gepflegt')
    expect(filters.features).toEqual(['balkon', 'garage'])
    expect(filters.onlyWithPhotos).toBe(true)
    expect(filters.includeCancelled).toBe(true)
    expect(filters.hideRulesOnly).toBe(true)
    expect(filters.priceMin).toBe(100000)
    expect(filters.priceMax).toBeNull()
    expect(filters.landMin).toBe(500)
    expect(filters.landMax).toBeNull()
  })

  it('defaults to no restriction / authority=all / category=all on an empty stored object', () => {
    const filters = toAuctionFilters({})
    expect(filters.countries).toEqual([])
    expect(filters.regionNameKeys).toBeNull()
    expect(filters.authority).toBe('all')
    expect(filters.category).toBe('all')
    expect(filters.condition).toBe('all')
    expect(filters.features).toEqual([])
    expect(filters.onlyWithPhotos).toBe(false)
    expect(filters.includeCancelled).toBe(false)
    expect(filters.hideRulesOnly).toBe(false)
    expect(filters.priceMin).toBeNull()
  })

  it('drops region keys that no longer resolve against the current registry', () => {
    const filters = toAuctionFilters({ region: 'de:unknown-region' })
    expect(filters.regionNameKeys).toEqual(new Set())
  })
})

describe('alert delivery state', () => {
  it('does not record a match when the recipient lookup fails', async () => {
    const { client, inserted } = alertSupabase({ userError: new Error('directory unavailable') })
    getServiceClient.mockReturnValue(client)

    await matchAlerts('de', 'sn', { auctions: [auction] } as never)

    expect(inserted).not.toHaveBeenCalled()
  })

  it('does not record a match when durable enqueue fails, so a later crawl can retry', async () => {
    const { client, inserted } = alertSupabase({ email: 'person@example.test' })
    getServiceClient.mockReturnValue(client)
    enqueueAlertDelivery.mockRejectedValueOnce(new Error('database down')).mockResolvedValueOnce(true)

    await matchAlerts('de', 'sn', { auctions: [auction] } as never)
    expect(inserted).not.toHaveBeenCalled()

    await matchAlerts('de', 'sn', { auctions: [auction] } as never)
    expect(enqueueAlertDelivery).toHaveBeenCalledTimes(2)
    expect(inserted).not.toHaveBeenCalled()
  })
})
