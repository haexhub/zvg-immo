import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { readCrawlStatusByCountry, readCrawlStatusList } = await import('./crawl-status')

afterEach(() => vi.clearAllMocks())

describe('readCrawlStatusByCountry', () => {
  it('sums bucket counts per country and rolls them into a total', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { country: 'de', bucket: 'done', count: '5' },
        { country: 'de', bucket: 'open', count: '2' },
        { country: 'de', bucket: 'error', count: '1' },
        { country: 'se', bucket: 'open', count: '3' },
      ],
    }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readCrawlStatusByCountry()).resolves.toEqual({
      de: { done: 5, open: 2, error: 1, total: 8 },
      se: { done: 0, open: 3, error: 0, total: 3 },
    })
  })

  it('returns an empty object when no DB is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readCrawlStatusByCountry()).resolves.toEqual({})
  })
})

describe('readCrawlStatusList', () => {
  it('maps rows to the DTO shape and reports the separately-queried total', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          platform: 'zvg-portal', external_id: '1', title: 'Haus', region: 'Berlin',
          case_number: '1 K 1/26', auction_date_iso: new Date('2026-09-01T00:00:00.000Z'),
          last_error_message: 'timeout',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: '42' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readCrawlStatusList('de', 'error', { limit: 50, offset: 0 })).resolves.toEqual({
      items: [{
        platform: 'zvg-portal', externalId: '1', title: 'Haus', region: 'Berlin',
        caseNumber: '1 K 1/26', auctionDateIso: '2026-09-01T00:00:00.000Z', lastErrorMessage: 'timeout',
      }],
      total: 42,
    })
    expect(query.mock.calls[0]?.[1]).toEqual(['de', 'error', 50, 0])
  })
})
