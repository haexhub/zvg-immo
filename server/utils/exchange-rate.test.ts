import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { Auction } from '~/types/auction'
import { deriveMarketValueEur, toEur } from './exchange-rate'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

const RATES = { CZK: 25, GBP: 0.85, BAM: 1.95583 }

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'cz',
    region: '',
    externalId: '1',
    caseNumber: '',
    authority: '',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

describe('toEur', () => {
  it('converts using units-of-currency-per-EUR', () => {
    expect(toEur(2500, 'CZK', RATES)).toBe(100)
  })

  it('returns null for a currency missing from the rates table', () => {
    expect(toEur(100, 'XYZ', RATES)).toBeNull()
  })
})

describe('deriveMarketValueEur', () => {
  it('converts marketValue+currency to marketValueEur for a non-EUR auction', () => {
    const a = auction({ marketValue: 1_762_800, currency: 'CZK' })
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBe(70512)
  })

  it('treats currency=EUR as identity', () => {
    const a = auction({ marketValue: 250_000, currency: 'EUR' })
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBe(250_000)
  })

  it('backfills marketValue/currency for an EUR-native auction (currency unset)', () => {
    const a = auction({ marketValueEur: 250_000 })
    deriveMarketValueEur(a, RATES)
    expect(a.currency).toBe('EUR')
    expect(a.marketValue).toBe(250_000)
    expect(a.marketValueEur).toBe(250_000)
  })

  it('leaves a fully-null auction untouched', () => {
    const a = auction()
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBeNull()
    expect(a.marketValue).toBeUndefined()
    expect(a.currency).toBeUndefined()
  })

  it('sets marketValueEur null for a currency the rates table has no entry for', () => {
    const a = auction({ marketValue: 100, currency: 'XYZ' })
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBeNull()
  })

  it('keeps the stored conversion of the same amount when the rate is missing', () => {
    const previous = auction({ marketValue: 100, currency: 'XYZ', marketValueEur: 40 })
    const same = auction({ marketValue: 100, currency: 'XYZ' })
    const changed = auction({ marketValue: 200, currency: 'XYZ' })
    deriveMarketValueEur(same, RATES, previous)
    deriveMarketValueEur(changed, RATES, previous)
    expect(same.marketValueEur).toBe(40)
    expect(changed.marketValueEur).toBeNull()
  })

  it('sets marketValueEur null when currency is known but no native value was found', () => {
    const a = auction({ marketValue: null, currency: 'GBP' })
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBeNull()
  })

  it('converts a pegged currency (BAM) merged into the rates table like any other', () => {
    const a = auction({ marketValue: 150_000, currency: 'BAM' })
    deriveMarketValueEur(a, RATES)
    expect(a.marketValueEur).toBe(Math.round(150_000 / 1.95583))
  })
})

describe('getRates', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('falls back to the expired disk cache when the live ECB fetch fails', async () => {
    const staleFetchedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() // 30h old, past the 24h TTL
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ fetchedAt: staleFetchedAt, rates: { USD: 1.1 } }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { getRates } = await import('./exchange-rate')
    const rates = await getRates()
    expect(rates.USD).toBe(1.1)
  })

  it('rejects a 200 response without the required rates and keeps serving the stale cache', async () => {
    const { writeFile } = await import('node:fs/promises')
    const staleFetchedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() // 30h old, past the 24h TTL
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ fetchedAt: staleFetchedAt, rates: { HUF: 400 } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Wartungsarbeiten</html>', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { getRates } = await import('./exchange-rate')
    expect((await getRates()).HUF).toBe(400)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('throws when there is no disk cache to fall back to and the live fetch fails', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { getRates } = await import('./exchange-rate')
    await expect(getRates()).rejects.toThrow('network down')
  })

  it('does not retry the live fetch on every call while serving a stale fallback', async () => {
    vi.useFakeTimers()
    const staleFetchedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() // 30h old, past the 24h TTL
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ fetchedAt: staleFetchedAt, rates: { USD: 1.1 } }))
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const { getRates } = await import('./exchange-rate')
    await getRates()
    await getRates()
    await getRates()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries the live fetch once the retry cooldown has elapsed', async () => {
    vi.useFakeTimers()
    const staleFetchedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() // 30h old, past the 24h TTL
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ fetchedAt: staleFetchedAt, rates: { USD: 1.1 } }))
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const { getRates } = await import('./exchange-rate')
    await getRates()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1) // past the 5min retry cooldown
    await getRates()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('deriveMarketValuesEur', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('never loads rates for a pure-EUR batch', async () => {
    vi.mocked(readFile).mockClear()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { deriveMarketValuesEur } = await import('./exchange-rate')
    const a = auction({ marketValueEur: 100_000 })

    await deriveMarketValuesEur([a])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(a.currency).toBe('EUR')
  })

  it('leaves foreign values unconverted instead of throwing on a cold cache plus ECB outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { deriveMarketValuesEur } = await import('./exchange-rate')
    const usd = auction({ marketValue: 200_000, currency: 'USD' })
    const bam = auction({ marketValue: 150_000, currency: 'BAM' })

    await deriveMarketValuesEur([usd, bam])

    expect(usd.marketValueEur).toBeNull()
    expect(bam.marketValueEur).toBe(Math.round(150_000 / 1.95583))
  })
  it('still loads the full ECB table on demand for a foreign batch', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ fetchedAt: new Date().toISOString(), rates: { USD: 1.25 } }))
    const { deriveMarketValuesEur } = await import('./exchange-rate')
    const usd = auction({ marketValue: 200_000, currency: 'USD' })

    await deriveMarketValuesEur([usd])

    expect(usd.marketValueEur).toBe(160_000)
  })
})

describe('loadRatesOrPegged', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('falls back to the pegged rates instead of throwing on a cold cache plus ECB outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { loadRatesOrPegged } = await import('./exchange-rate')

    await expect(loadRatesOrPegged()).resolves.toEqual({ BAM: 1.95583 })
  })
})
