import { computed, effectScope, nextTick, onScopeDispose, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'

// Nuxt auto-imports replaced with plain Vue reactivity. The useAsyncData stub
// resolves asynchronously like the real one, so anything the composable
// registers after awaiting it would run outside the caller's effect scope.
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url: string, opts: { query: { cacheOnly?: string } }) => (
    opts.query.cacheOnly ? null : { title: 'translated', address: null, description: null, documentSummary: null, extractionTexts: null }
  ))
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onScopeDispose', onScopeDispose)
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en') }))
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('useAsyncData', (_key: string, handler: () => Promise<unknown>) => {
    const result = { data: ref<unknown>(null), pending: ref(true) }
    const promise = handler().then((value) => {
      result.data.value = value
      result.pending.value = false
      return result
    })
    return Object.assign(promise, result)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAuctionDetailTranslation', () => {
  it('stops its translation watcher with the owning scope', async () => {
    const { useAuctionDetailTranslation } = await import('./useAuctionDetailTranslation')
    const auction = ref({ country: 'de', title: 'Haus', address: null, description: null, extraction: null } as unknown as AuctionDetail)
    const scope = effectScope()
    const state = await scope.run(() => useAuctionDetailTranslation({ auction, platform: 'zvg-portal', id: '1' }))!
    await vi.waitFor(() => expect(state.displayTitle.value).toBe('translated'))
    const callsBeforeUnmount = fetchMock.mock.calls.length

    scope.stop()
    auction.value = { ...auction.value, title: 'Wohnung' }
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount)
  })
})
