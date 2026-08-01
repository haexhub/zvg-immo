// "Zuletzt gesucht" (recent searches) in the Location popover — purely client-side (no account
// needed, unlike the /account saved searches), so a small localStorage list
// is enough. Newest first, capped so the popover stays short.
const STORAGE_KEY = 'zvg:recentSearches'
const MAX_ENTRIES = 5

export interface RecentSearchEntry {
  label: string
  query: Record<string, string>
}

function readAll(): RecentSearchEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
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
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
    }
  }

  return { entries, add }
}
