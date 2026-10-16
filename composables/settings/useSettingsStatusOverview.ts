export type StatusBucket = 'done' | 'error' | 'open' | 'pending'

export interface StatusCounts {
  done: number
  error: number
  open: number
  pending: number
  total: number
}

export interface StatusListItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  /** crawl-/llm-status only: not returned by translation-status (see startedAt). */
  auctionDateIso?: string | null
  lastErrorMessage: string | null
  llmFailures?: number
  /** translation-status only: which target language this row is for. */
  lang?: string
  /** translation-status only: when this attempt was claimed; null if still unstarted. */
  startedAt?: string | null
}

export interface StatusList {
  items: StatusListItem[]
  total: number
}

export interface DailyStatusSnapshot {
  snapshotDate: string
  country: string
  kind: 'crawl' | 'llm' | 'translation' | 'osm'
  targetLang: string | null
  done: number
  pending: number
  open: number
  error: number
  total: number
  capturedAt: string
}
