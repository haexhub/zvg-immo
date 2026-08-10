import { useSettingsAction } from './useSettingsAction'

export type StatusBucket = 'done' | 'error' | 'open'

export interface StatusCounts {
  done: number
  error: number
  open: number
  total: number
}

export interface StatusListItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  auctionDateIso: string | null
  lastErrorMessage: string | null
  llmFailures?: number
}

export interface StatusList {
  items: StatusListItem[]
  total: number
}

export interface StatusCountryRow extends StatusCounts {
  code: string
  label: string
}

const LIST_LIMIT = 50

/** Shared data-fetching for the crawl- and LLM-status donut cards: both load
 *  the same shape (per-country done/error/open counts, plus a paginated
 *  drill-down list for whichever segment is selected), just against
 *  different endpoints — see server/api/settings/{crawl,llm}-status[.get.ts|/[country].get.ts]. */
export function useSettingsStatusOverview(kind: 'crawl' | 'llm') {
  const countryLabel = useCountryLabel()
  const overview = useSettingsAction()
  const listAction = useSettingsAction()

  const counts = ref<Record<string, StatusCounts>>({})
  const rows = computed<StatusCountryRow[]>(() =>
    Object.entries(counts.value)
      .map(([code, c]) => ({ code, label: countryLabel(code), ...c }))
      .sort((a, b) => b.total - a.total),
  )

  const list = ref<StatusList>({ items: [], total: 0 })

  async function load(): Promise<void> {
    const result = await overview.run(
      () => $fetch<Record<string, StatusCounts>>(`/api/settings/${kind}-status`),
      'settings.statusOverview.loadError',
    )
    if (result) counts.value = result
  }

  async function loadList(country: string, bucket: StatusBucket, offset = 0): Promise<void> {
    const result = await listAction.run(
      () => $fetch<StatusList>(`/api/settings/${kind}-status/${country}`, { query: { bucket, limit: LIST_LIMIT, offset } }),
      'settings.statusOverview.listLoadError',
    )
    if (result) list.value = result
  }

  function clearList(): void {
    list.value = { items: [], total: 0 }
    listAction.error.value = null
  }

  return {
    rows,
    pending: overview.pending,
    error: overview.error,
    load,
    list,
    listPending: listAction.pending,
    listError: listAction.error,
    loadList,
    clearList,
    LIST_LIMIT,
  }
}
