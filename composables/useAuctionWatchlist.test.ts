import { ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-imports replaced with plain Vue reactivity and mocks.
const authFetchMock = vi.fn()
const navigateToMock = vi.fn()
const user = ref<{ id: string } | null>(null)

beforeEach(() => {
  authFetchMock.mockReset()
  navigateToMock.mockReset()
  user.value = null
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useAuth', () => ({ user }))
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
  vi.stubGlobal('useRoute', () => ({ fullPath: '/objekt/zvg-portal/1?tab=a' }))
  vi.stubGlobal('navigateTo', navigateToMock)
  vi.stubGlobal('authFetch', authFetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAuctionWatchlist', () => {
  it('sends a logged-out click to the login and back to the current page', async () => {
    const { useAuctionWatchlist } = await import('./useAuctionWatchlist')
    const { toggleWatchlist } = useAuctionWatchlist()

    await toggleWatchlist({ platform: 'zvg-portal', externalId: '1', authority: 'AG', caseNumber: 'K 1/26' })

    expect(navigateToMock).toHaveBeenCalledWith('/login?redirect=%2Fobjekt%2Fzvg-portal%2F1%3Ftab%3Da')
    expect(authFetchMock).not.toHaveBeenCalled()
  })
})
