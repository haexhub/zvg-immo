import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecentSearches } from './useRecentSearches'

const STORAGE_KEY = 'zvg:recentSearches'

function stubStorage(initial: string | null, setItem: (key: string, value: string) => void = () => {}) {
  vi.stubGlobal('window', { localStorage: { getItem: () => initial, setItem } })
}

beforeEach(() => {
  vi.stubGlobal('ref', ref)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useRecentSearches', () => {
  it('drops malformed and empty-query entries read from storage', () => {
    stubStorage(JSON.stringify([
      null,
      'Berlin',
      { label: 'In der Nähe', query: {} },
      { label: 'Schweden', query: { country: 'se' } },
      { label: 42, query: { country: 'de' } },
      { label: 'Bad', query: { country: 7 } },
    ]))

    const { entries, add } = useRecentSearches()

    expect(entries.value).toEqual([{ label: 'Schweden', query: { country: 'se' } }])
    expect(() => add('Deutschland', { country: 'de' })).not.toThrow()
    expect(entries.value.map((e) => e.label)).toEqual(['Deutschland', 'Schweden'])
  })

  it('keeps the in-memory entry when storage rejects the write', () => {
    stubStorage(null, () => { throw new DOMException('quota', 'QuotaExceededError') })

    const { entries, add } = useRecentSearches()

    expect(() => add('Schweden', { country: 'se' })).not.toThrow()
    expect(entries.value).toEqual([{ label: 'Schweden', query: { country: 'se' } }])
  })

  it('persists added entries under the storage key', () => {
    const setItem = vi.fn()
    stubStorage(null, setItem)

    useRecentSearches().add('Schweden', { country: 'se' })

    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify([{ label: 'Schweden', query: { country: 'se' } }]))
  })
})
