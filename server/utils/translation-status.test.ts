import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { readTranslationStatusByCountry, readTranslationStatusByCountryAndLanguage, readTranslationStatusList, readTranslationStatusIdentities } = await import('./translation-status')

afterEach(() => vi.clearAllMocks())

describe('readTranslationStatusByCountry', () => {
  it('includes unstarted, non-passthrough target languages in the open backlog', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { country: 'de', platform: 'de-zvg', external_id: '1', title: 'Haus', region: 'Berlin', case_number: '1 K 1/26', lang: 'de', status: null, error_message: null, started_at: null },
        { country: 'de', platform: 'de-zvg', external_id: '1', title: 'Haus', region: 'Berlin', case_number: '1 K 1/26', lang: 'en', status: null, error_message: null, started_at: null },
        { country: 'se', platform: 'se-kronofogden', external_id: '2', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'de', status: 'completed', error_message: null, started_at: new Date('2026-08-10T10:00:00.000Z') },
        { country: 'se', platform: 'se-kronofogden', external_id: '2', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'en', status: 'failed', error_message: 'boom', started_at: new Date('2026-08-10T10:00:00.000Z') },
      ],
    }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusByCountry()).resolves.toEqual({
      de: { done: 0, open: 1, error: 0, total: 1 },
      se: { done: 1, open: 0, error: 1, total: 2 },
    })
  })

  it('returns an empty object when no DB is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readTranslationStatusByCountry()).resolves.toEqual({})
  })

  it('keeps completed, open and failed work separate for each target language', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { country: 'se', platform: 'se-kronofogden', external_id: '1', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'de', status: 'completed', error_message: null, started_at: new Date() },
        { country: 'se', platform: 'se-kronofogden', external_id: '1', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'en', status: null, error_message: null, started_at: null },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusByCountryAndLanguage()).resolves.toEqual({
      se: {
        de: { done: 1, open: 0, error: 0, total: 1 },
        en: { done: 0, open: 1, error: 0, total: 1 },
      },
    })
  })
})

describe('readTranslationStatusList', () => {
  it('lists unstarted candidates as open rows with their target language', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { country: 'de', platform: 'de-zvg', external_id: '101738', title: 'Haus', region: 'Berlin', case_number: '1 K 2/26', lang: 'de', status: null, error_message: null, started_at: null },
        { country: 'de', platform: 'de-zvg', external_id: '101738', title: 'Haus', region: 'Berlin', case_number: '1 K 2/26', lang: 'en', status: null, error_message: null, started_at: null },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusList('de', 'open', { limit: 50, offset: 0 })).resolves.toEqual({
      items: [{
        platform: 'de-zvg', externalId: '101738', title: 'Haus', region: 'Berlin',
        caseNumber: '1 K 2/26', lang: 'en', lastErrorMessage: null, startedAt: null,
      }],
      total: 1,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([['de', 'en']])
  })

  it('filters a country list to one requested target language', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { country: 'se', platform: 'se-kronofogden', external_id: '1', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'de', status: null, error_message: null, started_at: null },
        { country: 'se', platform: 'se-kronofogden', external_id: '1', title: 'Hus', region: 'Gävleborg', case_number: 'F-1', lang: 'en', status: null, error_message: null, started_at: null },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusList('se', 'open', { lang: 'en' })).resolves.toMatchObject({
      total: 1,
      items: [{ lang: 'en' }],
    })
  })
})

describe('readTranslationStatusIdentities', () => {
  it('returns every failed (auction, lang) identity unpaginated, for the bulk retry endpoints', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { country: 'se', platform: 'se-kronofogden', external_id: '101738', title: 'Haus', region: 'Gävleborg', case_number: 'F-1', lang: 'de', status: 'failed', error_message: 'boom', started_at: new Date() },
        { country: 'se', platform: 'se-kronofogden', external_id: '101914', title: 'House', region: 'Gävleborg', case_number: 'F-2', lang: 'en', status: 'failed', error_message: 'boom', started_at: new Date() },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusIdentities('se', 'error')).resolves.toEqual([
      { platform: 'se-kronofogden', externalId: '101738', lang: 'de' },
      { platform: 'se-kronofogden', externalId: '101914', lang: 'en' },
    ])
  })

  it('returns an empty array when no DB is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readTranslationStatusIdentities('se', 'error')).resolves.toEqual([])
  })

  it('returns unstarted rows and only expired pending claims for the open bulk retry', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { country: 'se', platform: 'se-kronofogden', external_id: '101738', title: 'Haus', region: 'Gävleborg', case_number: 'F-1', lang: 'de', status: 'pending', error_message: null, started_at: new Date(Date.now() - 11 * 60 * 1000) },
        { country: 'se', platform: 'se-kronofogden', external_id: '101739', title: 'Haus', region: 'Gävleborg', case_number: 'F-2', lang: 'en', status: 'pending', error_message: null, started_at: new Date() },
        { country: 'se', platform: 'se-kronofogden', external_id: '101740', title: 'Haus', region: 'Gävleborg', case_number: 'F-3', lang: 'de', status: null, error_message: null, started_at: null },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await expect(readTranslationStatusIdentities('se', 'open')).resolves.toEqual([
      { platform: 'se-kronofogden', externalId: '101738', lang: 'de' },
      { platform: 'se-kronofogden', externalId: '101740', lang: 'de' },
    ])
    expect(query.mock.calls[0]?.[0]).toContain('JOIN auction_details d')
    expect(query.mock.calls[0]?.[1]).toEqual([['de', 'en']])
  })
})
