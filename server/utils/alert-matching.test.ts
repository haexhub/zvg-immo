import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterAuctions } from '~/lib/auction-filters'
import type { Auction } from '~/types/auction'

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
    // A nationwide-only country: its only registered region is the ALL_SCOPE
    // pseudo-entry, so picker keys carry the region name as their code.
    {
      code: 'bg',
      name: 'Bulgarien',
      regions: [{ code: 'all', name: 'Bulgarien', platforms: [] }],
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
      nearLat: '52.5',
      nearLng: '13.4',
      nearRadius: '25',
      nearSea: '5',
      urbanRural: 'rural',
    })

    expect(filters.countries).toEqual(['de'])
    expect(filters.regionNameKeys).toEqual(new Set(['de:Sachsen']))
    expect(filters.search).toBe('Wohnung')
    expect(filters.authority).toBe('AG Dresden')
    expect(filters.category).toBe('einfamilienhaus')
    expect(filters.condition).toEqual(['gepflegt'])
    expect(filters.features).toEqual(['balkon', 'garage'])
    expect(filters.onlyWithPhotos).toBe(true)
    expect(filters.includeCancelled).toBe(true)
    expect(filters.hideRulesOnly).toBe(true)
    expect(filters.priceMin).toBe(100000)
    expect(filters.priceMax).toBeNull()
    expect(filters.landMin).toBe(500)
    expect(filters.landMax).toBeNull()
    expect(filters.nearLat).toBe(52.5)
    expect(filters.nearLng).toBe(13.4)
    expect(filters.nearRadius).toBe(25)
    expect(filters.nearSea).toBe(5)
    expect(filters.urbanRural).toBe('rural')
  })

  it('defaults to no restriction / authority=all / category=all on an empty stored object', () => {
    const filters = toAuctionFilters({})
    expect(filters.countries).toEqual([])
    expect(filters.regionNameKeys).toBeNull()
    expect(filters.authority).toBe('all')
    expect(filters.category).toBe('all')
    expect(filters.condition).toEqual([])
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

  it('reads a nationwide-only country\'s key as the region name itself', () => {
    // Those options come from the stored auctions, not the registry (see
    // region-picker.ts) — resolving them against the registry would drop them
    // and silently widen the alert to the whole country.
    expect(toAuctionFilters({ region: 'bg:Burgas' }).regionNameKeys).toEqual(new Set(['bg:Burgas']))
  })

  it('shares nearby-distance semantics with the in-memory alert evaluator', () => {
    const filters = toAuctionFilters({ nearLat: '52.52', nearLng: '13.405', nearRadius: '10' })
    const base: Auction = {
      platform: 'test', country: 'de', region: 'Sachsen', externalId: 'x', caseNumber: '1', authority: 'AG', title: null,
      address: null, marketValueEur: null, marketValueText: null, auctionDateIso: null, auctionDateText: null,
      cancelled: false, sourceUpdatedIso: null, pdfUrl: null, detailUrl: null, pdfUrlUpstream: null,
      detailUrlUpstream: null, attachments: [], description: null, photoCount: 0, thumbnailUrl: null,
    }
    expect(filterAuctions([
      { ...base, externalId: 'near', lat: 52.52, lng: 13.405 },
      { ...base, externalId: 'far', lat: 53.551, lng: 9.993 },
    ], filters).map((auction) => auction.externalId)).toEqual(['near'])
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
