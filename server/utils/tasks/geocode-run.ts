import type { Auction } from '~/types/auction'
import { ensureEnabledCountriesLoaded } from '~/server/crawlers/registry'
import { readAuctionRecordsByKeys, type AuctionKey } from '~/server/utils/auction-record'
import { usableCoordinates } from '~/server/utils/coordinates'
import { CURRENT_AUCTION_CONDITIONS } from '~/server/utils/current-auction-sql'
import {
  recordGeocodeAttempts,
  upsertCurrentAuctions,
  type GeocodeAttempt,
} from '~/server/utils/current-auctions'
import { getPool } from '~/server/utils/db'
import { throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { activeGeocoderProvider, geocodeAddress, geocodeStatus } from '~/server/utils/geocode'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { enrichStoredVerkehrswert } from './geocode-verkehrswert'

// Matches recordGeocodeAttempts' own chunk size, so a flush is exactly one
// UPDATE statement.
const GEOCODE_ATTEMPT_FLUSH_SIZE = 500
// Resolved coordinates are written every this many hits: at the upstream's
// 1 req/s that is every couple of minutes on a cold run, and an aborted run
// keeps everything it resolved up to its last flush.
export const COORDINATE_FLUSH_SIZE = 100

export interface GeocodeCandidate extends AuctionKey {
  country: string
  address: string
}

export interface ResolvedCoordinates extends AuctionKey {
  lat: number
  lng: number
}

/**
 * Current auctions that have an address but no usable position. The address
 * comes from the live auction_details row (what the stored record's address
 * is read from too), so an address-less auction is never loaded at all.
 * 0/0 counts as missing (see coordinates.ts).
 *
 * Never-attempted auctions come first, then the oldest attempt: an address the
 * failure cooldown skipped last time is not stuck behind the same order.
 */
export async function findGeocodeCandidates(countries: readonly string[]): Promise<GeocodeCandidate[]> {
  if (countries.length === 0) return []
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<{ platform: string; external_id: string; country: string; address: string }>(
    `SELECT a.platform, a.external_id, a.country, d.address
       FROM auctions a
       JOIN auction_details d
         ON d.platform = a.platform AND d.external_id = a.external_id AND d.is_latest = true
      WHERE a.country = ANY($1)
        AND a.cancelled = false
        AND (a.lat IS NULL OR a.lng IS NULL OR (a.lat = 0 AND a.lng = 0))
        AND btrim(coalesce(d.address, '')) <> ''
        AND ${CURRENT_AUCTION_CONDITIONS.join(' AND ')}
      ORDER BY a.geocode_attempted_at ASC NULLS FIRST, a.platform, a.external_id`,
    [countries],
  )
  return rows.map((row) => ({
    platform: row.platform,
    externalId: row.external_id,
    country: row.country,
    address: row.address,
  }))
}

/**
 * Writes newly resolved positions onto their auctions. The stored records are
 * read right before the write (not at candidate time, possibly many minutes
 * earlier), so the identity fields upsertCurrentAuctions also writes are the
 * current ones; a position a crawler supplied in the meantime wins.
 *
 * Coordinates live only on `auctions` (WP-0), so no auction_details version
 * is written: the details would be unchanged.
 */
export async function persistResolvedCoordinates(resolved: readonly ResolvedCoordinates[]): Promise<number> {
  if (resolved.length === 0) return 0
  const records = await readAuctionRecordsByKeys(resolved, { includePhotos: false })
  const updated: Auction[] = []
  for (const hit of resolved) {
    const record = records.get(cacheKey(hit.platform, hit.externalId))
    if (!record || usableCoordinates(record.auction.lat, record.auction.lng)) continue
    record.auction.lat = hit.lat
    record.auction.lng = hit.lng
    updated.push(record.auction)
  }
  await upsertCurrentAuctions(updated, new Date().toISOString())
  return updated.length
}

export async function runGeocode(signal: AbortSignal) {
  const startedAt = Date.now()
  console.log('[geocode] start')

  const countries = await ensureEnabledCountriesLoaded()
  const candidates = await findGeocodeCandidates(countries)
  console.log(`[geocode] ${candidates.length} current auctions with an address but no coordinates`)

  let processed = 0
  let geocoded = 0
  let failed = 0
  let persistedCoordinates = 0
  const provider = activeGeocoderProvider()
  // Flushed in chunks rather than once at the end: a cold run takes ~40 min
  // and gets aborted whenever a newer run supersedes it (runExclusiveTask)
  // or the container redeploys — buffering everything would throw away the
  // observability and the resolved positions for exactly the long runs.
  const attempts: GeocodeAttempt[] = []
  const resolved: ResolvedCoordinates[] = []
  const flushAttempts = async (): Promise<void> => {
    if (attempts.length === 0) return
    const pending = attempts.splice(0, attempts.length)
    await recordGeocodeAttempts(pending, new Date().toISOString())
  }
  const flushResolved = async (): Promise<void> => {
    if (resolved.length === 0) return
    persistedCoordinates += await persistResolvedCoordinates(resolved.splice(0, resolved.length))
  }
  const startGeo = Date.now()
  try {
    for (const candidate of candidates) {
      throwIfTaskAborted(signal)
      processed++
      const point = await geocodeAddress(candidate.address, candidate.country, { fetchMissing: true }).catch(() => {
        failed++
        return null
      })
      if (point) {
        resolved.push({ platform: candidate.platform, externalId: candidate.externalId, lat: point.lat, lng: point.lng })
        geocoded++
      }
      // Recorded regardless of outcome: "never attempted" vs "attempted, still
      // unresolved" is only distinguishable in the DB once this run stamps it
      // (see WP-3) — 'pending' means the cache still has un-queried variants
      // (e.g. the failure cooldown skipped them this run).
      const status = point ? 'geocoded' : await geocodeStatus(candidate.address, candidate.country)
      attempts.push({ platform: candidate.platform, externalId: candidate.externalId, result: status, provider })
      if (attempts.length >= GEOCODE_ATTEMPT_FLUSH_SIZE) await flushAttempts()
      if (resolved.length >= COORDINATE_FLUSH_SIZE) await flushResolved()
      if (processed % 100 === 0 || processed === candidates.length) {
        const rate = processed / Math.max(1, (Date.now() - startGeo) / 1000)
        console.log(
          `[geocode] ${processed}/${candidates.length} · ${geocoded} hit · ${failed} err · ${rate.toFixed(1)}/s`,
        )
      }
    }
  } finally {
    await flushResolved()
    await flushAttempts()
  }

  const vw = await enrichStoredVerkehrswert(countries, signal)
  const vwAdded = vw.at.added + vw.be.added
  const vwErrors = vw.at.errors + vw.be.errors

  const durationMs = Date.now() - startedAt
  console.log(
    `[geocode] done in ${(durationMs / 1000).toFixed(0)}s · geocoded=${geocoded} persisted=${persistedCoordinates} failed=${failed} · verkehrswert(at)=${vw.at.added}/${vw.at.errors} · verkehrswert(be)=${vw.be.added}/${vw.be.errors}`,
  )

  return {
    result: {
      processed,
      geocoded,
      persistedCoordinates,
      failed,
      verkehrswertAdded: vwAdded,
      verkehrswertErrors: vwErrors,
      durationMs,
    },
  }
}
