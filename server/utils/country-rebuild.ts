import type { Pool } from 'pg'
import { createError } from 'h3'
import type { CrawlResult } from '~/types/auction'
import { crawlSingle, ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '../crawlers/registry'
import { matchAlerts } from './alert-matching'
import { archiveAuction } from './raw-archive'
import { recordObservations } from './history'
import { getPool } from './db'
import { writeListCache } from './list-cache'
import { invalidateAuctionSnapshot } from './auction-snapshot'
import { invalidateExtractionCache } from './extraction-cache'
import { invalidateLocationEnrichmentCache } from './external-data/location-enrichment'

export interface CountryRebuildResult {
  country: string
  deleted: {
    listCache: number
    auctionSnapshot: number
    extractionCache: number
    currentAuctions: number
    locationEnrichment: number
    auctionTranslations: number
  }
  crawled: {
    ok: number
    failed: number
    auctions: number
    durationMs: number
  }
  errors: Array<{ region: string; message: string }>
}

let runningCountry: string | null = null

function platformIdsForCountry(country: string): string[] {
  const entry = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!entry) return []
  return [
    ...new Set(entry.regions.flatMap((region) => region.platforms.map((platform) => platform.id))),
  ]
}

export async function deleteCountryCurrentData(db: Pool, country: string): Promise<CountryRebuildResult['deleted']> {
  const platformIds = platformIdsForCountry(country)
  const [
    listCache,
    currentAuctions,
    auctionSnapshot,
    extractionCache,
    locationEnrichment,
    auctionTranslations,
  ] = await Promise.all([
    db.query('DELETE FROM list_cache WHERE country = $1', [country]),
    db.query('DELETE FROM auctions WHERE country = $1', [country]),
    db.query(
      `DELETE FROM auction_snapshot
       WHERE auction->>'country' = $1 OR platform = ANY($2::text[])`,
      [country, platformIds],
    ),
    platformIds.length > 0
      ? db.query('DELETE FROM extraction_cache WHERE platform = ANY($1::text[])', [platformIds])
      : Promise.resolve({ rowCount: 0 }),
    // Kept in sync with extraction_cache/auction_snapshot above — these two
    // are keyed by the same (platform, external_id) identity but were
    // previously left out of the rebuild cleanup, leaving stale location
    // context / translations behind for a country that was otherwise wiped.
    platformIds.length > 0
      ? db.query('DELETE FROM location_enrichment WHERE platform = ANY($1::text[])', [platformIds])
      : Promise.resolve({ rowCount: 0 }),
    platformIds.length > 0
      ? db.query('DELETE FROM auction_translations WHERE platform = ANY($1::text[])', [platformIds])
      : Promise.resolve({ rowCount: 0 }),
  ])

  invalidateAuctionSnapshot()
  invalidateExtractionCache()
  invalidateLocationEnrichmentCache()

  return {
    listCache: listCache.rowCount ?? 0,
    auctionSnapshot: auctionSnapshot.rowCount ?? 0,
    extractionCache: extractionCache.rowCount ?? 0,
    currentAuctions: currentAuctions.rowCount ?? 0,
    locationEnrichment: locationEnrichment.rowCount ?? 0,
    auctionTranslations: auctionTranslations.rowCount ?? 0,
  }
}

export async function rebuildCountry(countryInput: string): Promise<CountryRebuildResult> {
  const country = countryInput.trim().toLowerCase()
  await ensureEnabledCountriesLoaded()
  const registered = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!registered) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  if (!isCountryEnabled(country)) {
    throw createError({ statusCode: 400, statusMessage: `${registered.name} ist deaktiviert.` })
  }
  if (runningCountry === country) {
    throw createError({ statusCode: 409, statusMessage: `${registered.name} wird bereits neu gecrawlt.` })
  }

  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }

  runningCountry = country
  const startedAt = Date.now()
  const capturedAt = new Date(startedAt).toISOString()
  try {
    const deleted = await deleteCountryCurrentData(db, country)
    const results: CrawlResult[] = []
    const errors: Array<{ region: string; message: string }> = []

    for (const region of registered.regions) {
      try {
        const result = await crawlSingle({
          country,
          region: region.code,
          immobilienOnly: true,
          enrichDetails: false,
        })
        await writeListCache(country, region.code, result)
        await recordObservations(result, capturedAt)
        await matchAlerts(country, region.code, result)
        for (const auction of result.auctions) {
          await archiveAuction(auction, capturedAt)
        }
        results.push(result)
      } catch (error) {
        errors.push({
          region: region.code,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      country,
      deleted,
      crawled: {
        ok: results.length,
        failed: errors.length,
        auctions: results.reduce((sum, result) => sum + result.auctions.length, 0),
        durationMs: Date.now() - startedAt,
      },
      errors,
    }
  } finally {
    runningCountry = null
  }
}
