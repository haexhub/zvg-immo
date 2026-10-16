import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, mapRow, type RawRow } from './list'
import { US_CHANNELS } from './constants'

function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    AuctionID: 123456,
    Asset_Title: 'Franklin County, PA Sheriff Sale: 761 FREY ROAD',
    ActualCloseTime: '2026-09-11T15:00:00',
    MinimumBid: 15000,
    DebtAmount: 87000,
    CourtCase: '2025-CV-1234',
    SheriffNumber: null,
    Defendant: 'John Doe',
    Plaintiff: 'Some Bank',
    Township: 'Guilford Township',
    Attorney: 'Some Law Firm',
    Address: '761 FREY ROAD, CHAMBERSBURG, PA',
    IsPostponedOrStayed: false,
    Images: null,
    ...overrides,
  }
}

describe('mapRow', () => {
  it('sets startingBid from MinimumBid', () => {
    const a = mapRow(makeRow(), [], 'us-bid4assets')
    expect(a.startingBid).toBe(15000)
    expect(a.currency).toBe('USD')
  })

  it('leaves startingBid null when MinimumBid is absent', () => {
    const a = mapRow(makeRow({ MinimumBid: null }), [], 'us-bid4assets')
    expect(a.startingBid).toBeNull()
  })

  it('never derives marketValueEur from DebtAmount or MinimumBid', () => {
    const a = mapRow(makeRow(), [], 'us-bid4assets')
    expect(a.marketValueEur).toBeNull()
    expect(a.marketValueText).toBeNull()
  })
})

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function gridPage(id: number): Response {
    const data = JSON.stringify({ Data: [makeRow({ AuctionID: id })], Total: 1 })
    return new Response(`<script>kendoGrid({"data":${data}})</script>`, { status: 200 })
  }

  async function run(failSlugs: Set<string>) {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let id = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        failSlugs.has(url.split('/').pop()!) ? new Response('', { status: 403 }) : gridPage(++id),
      ),
    )
    const promise = fetchAllListings('us-bid4assets')
    const settled = promise.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    )
    await vi.runAllTimersAsync()
    return settled
  }

  it('reports a run as complete when every channel loaded', async () => {
    const r = await run(new Set())
    expect('value' in r && r.value.complete).toBe(true)
    expect('value' in r && r.value.auctions).toHaveLength(US_CHANNELS.length)
  })

  it('marks the run incomplete when one channel fails', async () => {
    const r = await run(new Set([US_CHANNELS[0]!]))
    expect('value' in r && r.value.complete).toBe(false)
    expect('value' in r && r.value.auctions).toHaveLength(US_CHANNELS.length - 1)
  })

  it('throws when every channel fails', async () => {
    const r = await run(new Set(US_CHANNELS))
    expect('error' in r && r.error.message).toMatch(/all \d+ channels failed/)
  })
})
