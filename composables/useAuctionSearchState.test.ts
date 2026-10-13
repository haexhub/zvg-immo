import { computed, effectScope, nextTick, reactive, ref, watch, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The composable relies on Nuxt auto-imports; provide the handful it touches
// with plain Vue reactivity and a router that, like vue-router, swaps
// route.query on every non-duplicate navigation.
let route: { query: Record<string, string> }
let scope: EffectScope

function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

beforeEach(() => {
  route = reactive({ query: {} as Record<string, string> })
  const replace = vi.fn(({ query }: { query: Record<string, string> }) => {
    if (sameQuery(query, route.query)) return
    route.query = query
  })
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
  vi.stubGlobal('useCountryLabel', () => (code: string) => code)
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup(query: Record<string, string> = {}) {
  route.query = query
  const { useAuctionSearchState } = await import('./useAuctionSearchState')
  return scope.run(() => useAuctionSearchState({
    countries: ref([]),
    hideRulesOnlyServerDefault: computed(() => true),
    eurToDisplay: (amount) => amount,
    displayToEur: (amount) => amount,
  }))!
}

describe('useAuctionSearchState queryParams', () => {
  it('keeps its identity across pure map pans so useFetch does not refetch', async () => {
    const state = await setup({ country: 'de' })
    const initial = state.queryParams.value
    const fired = vi.fn()
    scope.run(() => watch(state.queryParams, fired))

    route.query = { country: 'de', mapLat: '51.1', mapLng: '10.2', mapZoom: '6' }
    await nextTick()
    route.query = { country: 'de', mapLat: '52.3', mapLng: '11.4', mapZoom: '7' }
    await nextTick()

    expect(state.queryParams.value).toBe(initial)
    expect(fired).not.toHaveBeenCalled()

    route.query = { country: 'at', mapLat: '52.3', mapLng: '11.4', mapZoom: '7' }
    await nextTick()

    expect(state.queryParams.value).not.toBe(initial)
    expect(state.queryParams.value).toMatchObject({ country: 'at' })
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
