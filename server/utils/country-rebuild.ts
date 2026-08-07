import { and, eq, exists, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import type { CrawlResult } from '~/types/auction'
import { crawlSingle, ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '../crawlers/registry'
import {
  auctionDetails,
  auctionFetchState,
  auctionObservations,
  auctions,
  auctionTranslations,
  listCache,
  locationEnrichment,
} from '../db/schema'
import { matchAlerts } from './alert-matching'
import { archiveAuction } from './raw-archive'
import { deleteRawArchiveCountry } from './raw-archive-delete'
import { recordObservations } from './history'
import { getDb } from './db'
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

export async function deleteCountryCurrentData<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  country: string,
): Promise<CountryRebuildResult['deleted']> {
  // Archive queries need the auction rows for country scoping, so archive/blob
  // deletion must happen first. File removal cannot join the SQL transaction;
  // if the relational delete fails, rerun rebuildCountry to recover.
  const archive = await deleteRawArchiveCountry(country)
  const deleted = await db.transaction(async (tx) => {
    // These four tables don't carry their own `country` column — they key off
    // (platform, external_id) — so scoping to a country goes through the
    // `auctions` row for that identity, mirroring the old `USING auctions a`
    // join.
    const belongsToCountry = (platform: AnyPgColumn, externalId: AnyPgColumn) =>
      exists(
        tx.select({ one: sql`1` }).from(auctions).where(and(
          eq(auctions.platform, platform),
          eq(auctions.externalId, externalId),
          eq(auctions.country, country),
        )),
      )

    const auctionTranslationsResult = await tx.delete(auctionTranslations)
      .where(belongsToCountry(auctionTranslations.platform, auctionTranslations.externalId))
    const auctionDetailsResult = await tx.delete(auctionDetails)
      .where(belongsToCountry(auctionDetails.platform, auctionDetails.externalId))
    const fetchStateResult = await tx.delete(auctionFetchState)
      .where(belongsToCountry(auctionFetchState.platform, auctionFetchState.externalId))
    const locationEnrichmentResult = await tx.delete(locationEnrichment)
      .where(belongsToCountry(locationEnrichment.platform, locationEnrichment.externalId))
    const observationsResult = await tx.delete(auctionObservations).where(eq(auctionObservations.country, country))
    const listCacheResult = await tx.delete(listCache).where(eq(listCache.country, country))
    const auctionsResult = await tx.delete(auctions).where(eq(auctions.country, country))

    return {
      listCache: listCacheResult.rowCount ?? 0,
      observations: observationsResult.rowCount ?? 0,
      auctions: auctionsResult.rowCount ?? 0,
      auctionDetails: auctionDetailsResult.rowCount ?? 0,
      fetchState: fetchStateResult.rowCount ?? 0,
      locationEnrichment: locationEnrichmentResult.rowCount ?? 0,
      auctionTranslations: auctionTranslationsResult.rowCount ?? 0,
      artifactCaptures: archive.deleted.captures,
      artifactVersions: archive.deleted.documentSets,
      artifactVersionItems: archive.deleted.documentSetItems,
      artifactBlobs: archive.deleted.blobs,
    }
  })
  // After the commit, not inside the callback: a concurrent request that
  // repopulated the cache from rows this transaction had not removed yet would
  // otherwise leave enrichment entries for deleted auctions behind.
  invalidateLocationEnrichmentCache()
  return deleted
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

  const db = getDb()
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
