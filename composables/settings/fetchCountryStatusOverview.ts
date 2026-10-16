import type { ContentTargetLang } from '~/lib/content-language'
import type { OsmImportCountryStatus } from '~/server/utils/osm-status'
import type { DailyStatusSnapshot, StatusCounts } from './useSettingsStatusOverview'

export interface CountryStatusOverviewData {
  crawl: Record<string, StatusCounts>
  llm: Record<string, StatusCounts>
  translation: Record<string, Partial<Record<ContentTargetLang, StatusCounts>>>
  osm: OsmImportCountryStatus[]
  snapshots: DailyStatusSnapshot[]
}

/** Loads the live cards first; a history outage must never hide live status. */
export async function fetchCountryStatusOverview(): Promise<CountryStatusOverviewData> {
  const [crawl, llm, translation, osm] = await Promise.all([
    $fetch<Record<string, StatusCounts>>('/api/settings/crawl-status'),
    $fetch<Record<string, StatusCounts>>('/api/settings/llm-status'),
    $fetch<Record<string, Partial<Record<ContentTargetLang, StatusCounts>>>>('/api/settings/translation-status-by-language'),
    $fetch<{ countries: OsmImportCountryStatus[] }>('/api/settings/osm-import'),
  ])
  const snapshots = await $fetch<{ snapshots: DailyStatusSnapshot[] }>('/api/settings/status-snapshots', {
    query: { days: 90 },
  }).catch(() => ({ snapshots: [] }))
  return { crawl, llm, translation, osm: osm.countries, snapshots: snapshots.snapshots }
}
