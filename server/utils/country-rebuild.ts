import type { Pool } from 'pg'
import { createError } from 'h3'
import type { CrawlResult } from '~/types/auction'
import { crawlSingle, ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '../crawlers/registry'
import { matchAlerts } from './alert-matching'
import { archiveAuction } from './raw-archive'
import { deleteRawArchiveCountry, rollbackQuietly } from './raw-archive-delete'
import { recordObservations } from './history'
import { getPool } from './db'
import { ensureAuctionIdentity } from './current-auctions'
import { writeAuctionCrawlFetchState } from './auction-fetch-state'
import { writeListCache } from './list-cache'
import { invalidateLocationEnrichmentCache } from './external-data/location-enrichment'

export interface CountryRebuildResult {
  country: string
  deleted: {
    listCache: number
    observations: number
    auctions: number
    auctionDetails: number
    fetchState: number
    locationEnrichment: number
    auctionTranslations: number
    artifactCaptures: number
    artifactVersions: number
    artifactVersionItems: number
    artifactBlobs: number
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

export async function deleteCountryCurrentData(db: Pool, country: string): Promise<CountryRebuildResult['deleted']> {
  // Archive queries need the auction rows for country scoping, so archive/blob
  // deletion must happen first. File removal cannot join the SQL transaction;
  // if the relational delete fails, rerun rebuildCountry to recover.
  const archive = await deleteRawArchiveCountry(country)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const auctionTranslations = await client.query(
      `DELETE FROM auction_translations t USING auctions a
       WHERE a.platform = t.platform AND a.external_id = t.external_id AND a.country = $1`,
      [country],
    )
    const auctionDetails = await client.query(
      `DELETE FROM auction_details d USING auctions a
       WHERE a.platform = d.platform AND a.external_id = d.external_id AND a.country = $1`,
      [country],
    )
    const fetchState = await client.query(
      `DELETE FROM auction_fetch_state fs USING auctions a
       WHERE a.platform = fs.platform AND a.external_id = fs.external_id AND a.country = $1`,
      [country],
    )
    const locationEnrichment = await client.query(
      `DELETE FROM location_enrichment le USING auctions a
       WHERE a.platform = le.platform AND a.external_id = le.external_id AND a.country = $1`,
      [country],
    )
    const observations = await client.query('DELETE FROM auction_observations WHERE country = $1', [country])
    const listCache = await client.query('DELETE FROM list_cache WHERE country = $1', [country])
    const auctions = await client.query('DELETE FROM auctions WHERE country = $1', [country])
    await client.query('COMMIT')
    invalidateLocationEnrichmentCache()
    return {
      listCache: listCache.rowCount ?? 0,
      observations: observations.rowCount ?? 0,
      auctions: auctions.rowCount ?? 0,
      auctionDetails: auctionDetails.rowCount ?? 0,
      fetchState: fetchState.rowCount ?? 0,
      locationEnrichment: locationEnrichment.rowCount ?? 0,
      auctionTranslations: auctionTranslations.rowCount ?? 0,
      artifactCaptures: archive.deleted.captures,
      artifactVersions: archive.deleted.documentSets,
      artifactVersionItems: archive.deleted.documentSetItems,
      artifactBlobs: archive.deleted.blobs,
    }
  } catch (err) {
    await rollbackQuietly(client)
    throw err
  } finally {
    client.release()
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
        await ensureAuctionIdentity(result.auctions)
        await writeAuctionCrawlFetchState(result.auctions)
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
