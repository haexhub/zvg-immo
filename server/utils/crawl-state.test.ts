import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, CrawlResult } from '~/types/auction'

const query = vi.fn()
let failNextQuery = false
vi.mock('./db', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => {
      if (failNextQuery) return Promise.reject(new Error('connection lost'))
      return query(...args)
    },
  }),
}))

function auction(platform: string, externalId: string): Auction {
  return {
    platform,
    country: 'de',
    region: 'Berlin',
    externalId,
    caseNumber: '',
    authority: 'AG Berlin',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: '',
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

function result(overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    platform: 'multi',
    platformsSucceeded: ['zvg-portal'],
    source: '',
    countries: ['de'],
    regions: ['Berlin'],
    fetchedAt: '2026-08-19T10:00:00.000Z',
    totalReported: null,
    auctions: [auction('zvg-portal', '1'), auction('zvg-portal', '2')],
    ...overrides,
  }
}

const AT = '2026-08-19T10:00:00.000Z'

beforeEach(() => {
  failNextQuery = false
  query.mockReset().mockResolvedValue({ rows: [] })
})
afterEach(() => vi.restoreAllMocks())

describe('recordCrawlScope', () => {
  it('stamps the crawled auctions and the scope with the same instant', async () => {
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'be', result(), AT)

    const [auctionSql, auctionValues] = query.mock.calls[0]!
    expect(auctionSql).toContain('UPDATE auctions SET last_seen_at = $1, crawl_region = $2')
    expect(auctionValues.slice(0, 2)).toEqual([AT, 'be'])

    const [scopeSql, scopeValues] = query.mock.calls[1]!
    expect(scopeSql).toContain('INSERT INTO crawl_state')
    expect(scopeValues.slice(0, 3)).toEqual(['de', 'be', AT])
    // Same timestamp on both sides, so the read-side comparison is an exact >=.
    expect(auctionValues[0]).toBe(scopeValues[2])
  })

  it('stamps auctions before the scope, so a crash in between hides nothing', async () => {
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'be', result(), AT)

    expect(query.mock.calls[0]![0]).toContain('UPDATE auctions')
    expect(query.mock.calls[1]![0]).toContain('INSERT INTO crawl_state')
  })

  it('writes nothing when every platform covering the region failed', async () => {
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'be', result({ platformsSucceeded: [], auctions: [] }), AT)

    expect(query).not.toHaveBeenCalled()
  })

  it('records a platform that succeeded with zero listings, so its catalog can expire', async () => {
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'be', result({ auctions: [] }), AT)

    // No auctions to stamp, but the scope must still advance — otherwise a
    // source whose last listing sold would keep showing that listing forever.
    const [scopeSql, scopeValues] = query.mock.calls[0]!
    expect(scopeSql).toContain('INSERT INTO crawl_state')
    expect(scopeValues).toContain('zvg-portal')
    expect(scopeValues).toContain(0)
  })

  it('counts listings per platform when several cover one region', async () => {
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'bw', result({
      platformsSucceeded: ['zvg-portal', 'zvbawu'],
      auctions: [auction('zvg-portal', '1'), auction('zvg-portal', '2'), auction('zvbawu', '3')],
    }), AT)

    const scopeValues = query.mock.calls[1]![1]
    expect(scopeValues).toEqual(['de', 'bw', AT, 'zvg-portal', 2, 'zvbawu', 1])
  })

  it('guards both writes against an older run overwriting newer state', async () => {
    // refresh/enrich/country-rebuild share no lock, so a slower run that
    // started earlier can finish after a faster, later one covering the same
    // scope — its older `at` must not win.
    const { recordCrawlScope } = await import('./crawl-state')
    await recordCrawlScope('de', 'be', result(), AT)

    const [auctionSql] = query.mock.calls[0]!
    expect(auctionSql).toContain('AND (last_seen_at IS NULL OR last_seen_at < $1)')

    const [scopeSql] = query.mock.calls[1]!
    expect(scopeSql).toContain('WHERE EXCLUDED.last_success_at > crawl_state.last_success_at')
  })
})

describe('allScopesFreshWithin', () => {
  const scopes = [
    { country: 'de', region: 'be', platform: 'zvg-portal' },
    { country: 'de', region: 'bw', platform: 'zvbawu' },
  ]

  it('returns false without querying when there are no scopes to check', async () => {
    const { allScopesFreshWithin } = await import('./crawl-state')
    expect(await allScopesFreshWithin([], 60_000)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('is true only when every scope has a fresh row — one missing or stale scope fails the whole check', async () => {
    const { allScopesFreshWithin } = await import('./crawl-state')

    query.mockResolvedValueOnce({ rows: [{ stale: '0' }] })
    expect(await allScopesFreshWithin(scopes, 60_000)).toBe(true)

    query.mockResolvedValueOnce({ rows: [{ stale: '1' }] })
    expect(await allScopesFreshWithin(scopes, 60_000)).toBe(false)
  })

  it('checks every registered scope against the same cutoff, not just the newest one', async () => {
    const { allScopesFreshWithin } = await import('./crawl-state')
    query.mockResolvedValueOnce({ rows: [{ stale: '0' }] })
    await allScopesFreshWithin(scopes, 60_000)

    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('LEFT JOIN crawl_state cs')
    expect(values).toEqual([
      expect.any(String),
      'de', 'be', 'zvg-portal',
      'de', 'bw', 'zvbawu',
    ])
  })

  it('returns false rather than throwing when the query fails', async () => {
    const { allScopesFreshWithin } = await import('./crawl-state')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    failNextQuery = true

    expect(await allScopesFreshWithin(scopes, 60_000)).toBe(false)
  })
})

describe('regionCrawlAgeMs', () => {
  it('returns null while any platform covering the region has never been crawled', async () => {
    const { regionCrawlAgeMs } = await import('./crawl-state')
    query.mockResolvedValue({ rows: [{ oldest: '2026-08-19T09:00:00.000Z', covered: '1' }] })

    // A newly added platform must not be starved of its first crawl just
    // because a sibling keeps the region looking fresh.
    expect(await regionCrawlAgeMs('de', 'bw', ['zvg-portal', 'zvbawu'])).toBeNull()
  })

  it('measures from the stalest platform once all of them are covered', async () => {
    const { regionCrawlAgeMs } = await import('./crawl-state')
    const oldest = new Date(Date.now() - 7_200_000).toISOString()
    query.mockResolvedValue({ rows: [{ oldest, covered: '2' }] })

    const age = await regionCrawlAgeMs('de', 'bw', ['zvg-portal', 'zvbawu'])
    expect(age).toBeGreaterThanOrEqual(7_200_000)
  })

  it('returns null rather than throwing when the query fails', async () => {
    const { regionCrawlAgeMs } = await import('./crawl-state')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A plain throwing function, not a vi.fn(): vitest's mock wrapper tracks
    // the returned promise's settlement and surfaces the rejection as an
    // unhandled error even though crawl-state.ts catches it.
    failNextQuery = true

    // The refresh cadence must degrade to "crawl it again", never crash the run.
    expect(await regionCrawlAgeMs('de', 'be', ['zvg-portal'])).toBeNull()
  })
})
