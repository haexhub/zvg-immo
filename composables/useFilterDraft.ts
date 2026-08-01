import type { Ref } from 'vue'

// SearchPropertiesPopover/SearchEnvironmentPopover stage their fields locally while open and only
// write back to the real (committed, URL-synced) refs on "Anwenden" —
// otherwise every keystroke would trip useAuctionSearchState's query-sync
// watcher and refetch /api/auctions immediately (see composables/useAuctionSearchState.ts).
export function useFilterDraft<M extends Record<string, Ref<any>>>(models: M, isOpen: Ref<boolean>) {
  type Draft = { [K in keyof M]: M[K]['value'] }

  function snapshot(): Draft {
    const out = {} as Draft
    for (const key in models) out[key] = models[key]!.value
    return out
  }

  const draft = reactive(snapshot()) as Draft

  watch(isOpen, (open) => {
    if (open) Object.assign(draft, snapshot())
  })

  function commit(): void {
    for (const key in models) models[key]!.value = draft[key]
  }

  return { draft, commit }
}
