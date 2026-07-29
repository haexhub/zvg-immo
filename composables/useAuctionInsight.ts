// Shared fetch/pending/error plumbing for on-demand LLM insight cards
// (server/utils/insights/registry.ts). Purely user-triggered — unlike the
// auto-firing translation fetch, `generate()` only runs on an explicit call
// (a button click). Rendering of the payload stays bespoke per card; this
// composable only generalizes the request lifecycle.
import type { Ref } from 'vue'

export interface UseAuctionInsightResult<T> {
  payload: Ref<T | null>
  pending: Ref<boolean>
  error: Ref<boolean>
  generate: () => Promise<void>
}

export function useAuctionInsight<T>(insightId: string, platform: string, id: string): UseAuctionInsightResult<T> {
  const payload = ref<T | null>(null) as Ref<T | null>
  const pending = ref(false)
  const error = ref(false)

  async function generate(): Promise<void> {
    if (pending.value) return
    pending.value = true
    error.value = false
    try {
      const res = await $fetch<{ payload: T, at: string }>(
        `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/insight/${encodeURIComponent(insightId)}`,
        { method: 'POST' },
      )
      payload.value = res.payload
    } catch {
      error.value = true
    } finally {
      pending.value = false
    }
  }

  return { payload, pending, error, generate }
}
