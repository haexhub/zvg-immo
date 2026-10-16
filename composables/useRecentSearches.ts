// "Zuletzt gesucht" (recent searches) in the Location popover — purely client-side (no account
// needed, unlike the /account saved searches), so a small localStorage list
// is enough. Newest first, capped so the popover stays short.
const STORAGE_KEY = 'zvg:recentSearches'
const MAX_ENTRIES = 5

export interface RecentSearchEntry {
  label: string
  query: Record<string, string>
}

// Storage is user-editable and outlives app versions, so keep only entries
// that are safe to render and replay. An empty query is dropped too: older
// "nearby" entries were saved without coordinates and would clear every
// filter when picked.
function isRecentSearchEntry(value: unknown): value is RecentSearchEntry {
  if (value == null || typeof value !== 'object') return false
  const { label, query } = value as Partial<Record<keyof RecentSearchEntry, unknown>>
  if (typeof label !== 'string' || !label.trim()) return false
  if (query == null || typeof query !== 'object' || Array.isArray(query)) return false
  const values = Object.values(query)
  return values.length > 0 && values.every((v) => typeof v === 'string')
}

function readAll(): RecentSearchEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isRecentSearchEntry).slice(0, MAX_ENTRIES) : []
  } catch {
    return []
  }
}

export function useRecentSearches() {
  const entries = ref<RecentSearchEntry[]>(readAll())

  function add(label: string, query: Record<string, string>): void {
    if (!label.trim()) return
    const deduped = entries.value.filter((e) => e.label !== label)
    entries.value = [{ label, query }, ...deduped].slice(0, MAX_ENTRIES)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
    } catch {
      // Blocked site data or a full quota: the entry still shows for this
      // session, it just isn't remembered across reloads.
    }
  }

  return { entries, add }
}
