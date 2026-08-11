import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { readTranslationStatusByCountry, readTranslationStatusList, readTranslationStatusIdentities } = await import('./translation-status')

afterEach(() => vi.clearAllMocks())

describe('readTranslationStatusByCountry', () => {
  it('maps completed/failed/pending to done/error/open and sums a total', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { country: 'de', status: 'completed', count: '4' },
        { country: 'de', status: 'pending', count: '1' },
        { country: 'de', status: 'failed', count: '2' },
        { country: 'se', status: 'completed', count: '3' },
      ],
    }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusByCountry()).resolves.toEqual({
      de: { done: 4, open: 1, error: 2, total: 7 },
      se: { done: 3, open: 0, error: 0, total: 3 },
    })
  })

  it('returns an empty object when no DB is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readTranslationStatusByCountry()).resolves.toEqual({})
  })
})

describe('readTranslationStatusList', () => {
  it('translates the bucket to its status value and maps rows to the DTO shape', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          platform: 'se-kronofogden', external_id: '101738', title: 'Haus', region: 'Gävleborg',
          case_number: 'F-1', lang: 'de', error_message: 'LLM nicht konfiguriert',
          started_at: new Date('2026-08-10T10:00:00.000Z'),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: '9' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusList('se', 'error', { limit: 50, offset: 0 })).resolves.toEqual({
      items: [{
        platform: 'se-kronofogden', externalId: '101738', title: 'Haus', region: 'Gävleborg',
        caseNumber: 'F-1', lang: 'de', lastErrorMessage: 'LLM nicht konfiguriert',
        startedAt: '2026-08-10T10:00:00.000Z',
      }],
      total: 9,
    })
    expect(query.mock.calls[0]?.[1]).toEqual(['se', 'failed', 50, 0])
  })
})

describe('readTranslationStatusIdentities', () => {
  it('returns every matching (auction, lang) identity unpaginated, for the bulk retry endpoints', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { platform: 'se-kronofogden', external_id: '101738', lang: 'de' },
        { platform: 'se-kronofogden', external_id: '101914', lang: 'en' },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusIdentities('se', 'error')).resolves.toEqual([
      { platform: 'se-kronofogden', externalId: '101738', lang: 'de' },
      { platform: 'se-kronofogden', externalId: '101914', lang: 'en' },
    ])
    expect(query.mock.calls[0]?.[1]).toEqual(['se', 'failed'])
  })

  it('returns an empty array when no DB is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readTranslationStatusIdentities('se', 'error')).resolves.toEqual([])
  })
})
