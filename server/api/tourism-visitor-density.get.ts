// GET /api/tourism-visitor-density — the whole cached NUTS2 visitor-
// intensity collection for the search-map overlay
// (composables/useTourismVisitorLayer.ts). Unlike /api/tourism-grid, this is
// NOT bbox-scoped: GISCO's whole-of-Europe NUTS2 boundary set at 1:20M
// simplification is well under 1MB (~242 regions), so there is nothing to
// page or range-scan — the client fetches it once per session.
import { getPool } from '~/server/utils/db'
import {
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'
import { readCachedFileCollection } from '~/server/utils/external-data/cached-file-collection'
import { readTourismNutsCache, type TourismNutsRegion } from '~/server/utils/external-data/eurostat-tourism-nuts'

const SOURCE_ID = 'eurostat-regional-tourism-nights'

export interface TourismVisitorDensityResponse {
  available: boolean
  unit: 'P_KM2'
  generatedAt: string
  breaks: number[]
  regions: TourismNutsRegion[]
}

// This layer is optional (unconfigured, or never imported yet) — the
// frontend just hides its toggle rather than treating either case as an
// error, so both resolve to this same 200 response.
const UNAVAILABLE: TourismVisitorDensityResponse = { available: false, unit: 'P_KM2', generatedAt: '', breaks: [], regions: [] }

async function resolveConfiguredCachePath(): Promise<string | null> {
  const source = getConfigurableExternalDataSource(SOURCE_ID)
  if (!source) return null
  const db = getPool()
  const stored = db ? await getStoredExternalDataSourceConfig(db, SOURCE_ID) : {}
  const runtimeConfig = (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}
  const resolved = resolveExternalDataSourceConfig(source, stored, runtimeConfig)
  return resolved.isConfigured ? String(resolved.values.cachePath) : null
}

export default defineEventHandler(async (event): Promise<TourismVisitorDensityResponse> => {
  const cachePath = await resolveConfiguredCachePath()
  if (!cachePath) return UNAVAILABLE

  try {
    const collection = await readCachedFileCollection(cachePath, readTourismNutsCache)
    // Eurostat updates the underlying statistic a few times a year at most —
    // an hour of caching is invisible against that, unlike Phase 1's grid
    // (300s), which is trimming pan/zoom chatter against a much larger table.
    setResponseHeader(event, 'cache-control', 'public, max-age=3600')
    return {
      available: true,
      unit: collection.unit,
      generatedAt: collection.generatedAt,
      breaks: collection.breaks,
      regions: collection.regions,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return UNAVAILABLE
    throw err
  }
})
