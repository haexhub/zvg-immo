import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import type { AuctionKey, AuctionRecord } from '~/server/utils/auction-record'
import { getPool } from '~/server/utils/db'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecordsByKeys: vi.fn() }))
vi.mock('~/server/utils/verkehrswert-cache', async (importOriginal) => ({
  ...await importOriginal<typeof import('~/server/utils/verkehrswert-cache')>(),
  readVerkehrswertCache: vi.fn(),
  writeVerkehrswertCache: vi.fn(async () => undefined),
}))
vi.mock('~/server/crawlers/at/detail', () => ({ enrichInBatches: vi.fn() }))
vi.mock('~/server/crawlers/biddit/detail', () => ({
  enrichInBatches: vi.fn(),
  formatVerkehrswertText: vi.fn(() => 'formatted'),
}))

const { readAuctionRecordsByKeys } = await import('~/server/utils/auction-record')
const { readVerkehrswertCache, writeVerkehrswertCache } = await import('~/server/utils/verkehrswert-cache')
const { enrichInBatches: enrichAt } = await import('~/server/crawlers/at/detail')
const { enrichInBatches: enrichBiddit } = await import('~/server/crawlers/biddit/detail')
const { enrichStoredVerkehrswert } = await import('./geocode-verkehrswert')

/** The keys query answers per platform from this table. */
const stored: Record<string, string[]> = {}
const query = vi.fn(async (_sql: string, params: unknown[]) => ({
  rows: (stored[params[0] as string] ?? []).map((externalId) => ({ platform: params[0], external_id: externalId })),
}))

function record(key: AuctionKey): AuctionRecord {
  return {
    auction: {
      platform: key.platform,
      externalId: key.externalId,
      detailUrlUpstream: `https://example.test/${key.externalId}`,
    } as Auction,
    detailsId: null,
    detailsVersion: null,
    artifactVersionId: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(stored)) delete stored[key]
  vi.mocked(getPool).mockReturnValue({ query } as never)
  vi.mocked(readAuctionRecordsByKeys).mockImplementation(async (keys) =>
    new Map(keys.map((key) => [`${key.platform}:${key.externalId}`, record(key)])))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('enrichStoredVerkehrswert', () => {
  it('fetches details only for stored current auctions missing from the cache', async () => {
    stored['at-edikte'] = ['a1', 'a2']
    stored.biddit = ['b1', 'b2', 'b3']
    vi.mocked(readVerkehrswertCache).mockResolvedValue({
      'at-edikte:a1': { marketValueEur: 100, marketValueText: '100 €' },
      'biddit:b1': { marketValueEur: 5, marketValueText: null },
      'biddit:b2': { marketValueEur: null, marketValueText: null, retried: true },
    })
    vi.mocked(enrichAt).mockImplementation(async (auctions, apply) => {
      for (const a of auctions) apply(a, { schaetzwertEur: 200, schaetzwertText: '200 €' } as never)
      return { enriched: auctions.length, errors: 0 }
    })
    vi.mocked(enrichBiddit).mockImplementation(async (auctions, apply) => {
      for (const a of auctions) apply(a, { estimatedPrice: null } as never)
      return { enriched: 0, errors: 1 }
    })

    const result = await enrichStoredVerkehrswert(['at', 'be'], new AbortController().signal)

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('a.auction_date_iso IS NULL OR a.auction_date_iso >= now()')
    expect(params).toEqual(['at-edikte', ['at', 'be']])
    expect(vi.mocked(readAuctionRecordsByKeys).mock.calls.map(([keys]) => keys.map((k) => k.externalId)).sort())
      .toEqual([['a2'], ['b3']])
    expect(vi.mocked(enrichAt).mock.calls[0]![0].map((a) => a.detailUrlUpstream)).toEqual(['https://example.test/a2'])
    expect(result).toEqual({ at: { added: 1, errors: 0 }, be: { added: 1, errors: 1 } })
    expect(writeVerkehrswertCache).toHaveBeenCalledWith(expect.objectContaining({
      'at-edikte:a1': { marketValueEur: 100, marketValueText: '100 €' },
      'at-edikte:a2': { marketValueEur: 200, marketValueText: '200 €' },
      'biddit:b3': { marketValueEur: null, marketValueText: 'formatted', retried: true },
    }))
  })

  it('reads no records and writes nothing when everything is cached', async () => {
    stored['at-edikte'] = ['a1']
    vi.mocked(readVerkehrswertCache).mockResolvedValue({ 'at-edikte:a1': { marketValueEur: null, marketValueText: null } })

    expect(await enrichStoredVerkehrswert(['at'], new AbortController().signal))
      .toEqual({ at: { added: 0, errors: 0 }, be: { added: 0, errors: 0 } })
    expect(readAuctionRecordsByKeys).not.toHaveBeenCalled()
    expect(writeVerkehrswertCache).not.toHaveBeenCalled()
  })

  it('keeps the entries fetched before an abort', async () => {
    const controller = new AbortController()
    stored['at-edikte'] = Array.from({ length: 501 }, (_, i) => `a${i}`)
    vi.mocked(readVerkehrswertCache).mockResolvedValue({})
    vi.mocked(enrichAt).mockImplementation(async (auctions, apply) => {
      apply(auctions[0]!, { schaetzwertEur: 1, schaetzwertText: null } as never)
      controller.abort(new Error('superseded'))
      return { enriched: 1, errors: 0 }
    })

    await expect(enrichStoredVerkehrswert(['at'], controller.signal)).rejects.toThrow('superseded')
    expect(readAuctionRecordsByKeys).toHaveBeenCalledTimes(1)
    expect(writeVerkehrswertCache).toHaveBeenCalledWith({ 'at-edikte:a0': { marketValueEur: 1, marketValueText: null } })
  })
})
