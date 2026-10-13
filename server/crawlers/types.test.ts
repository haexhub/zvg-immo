import { describe, expect, it } from 'vitest'
import { createCrawlResult } from './types'

const input = { platform: 'p', source: 's', country: 'xx', regions: [{ code: 'all', name: 'All' }], totalReported: null, auctions: [] }

describe('createCrawlResult', () => {
  it('marks a complete (or unflagged) walk as succeeded', () => {
    expect(createCrawlResult(input).platformsSucceeded).toEqual(['p'])
    expect(createCrawlResult({ ...input, complete: true }).platformsSucceeded).toEqual(['p'])
  })

  it('leaves an incomplete walk out of platformsSucceeded', () => {
    expect(createCrawlResult({ ...input, complete: false }).platformsSucceeded).toEqual([])
  })
})
