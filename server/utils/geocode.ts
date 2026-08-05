// Geocodes addresses via a Nominatim-compatible backend, with a ~1 req/s rate
// limit and a disk-backed cache so repeat lookups are free.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildGeocodeQueries } from './geocode-normalizers'

export {
  normalizeBgAddress,
  normalizeEeAddress,
  normalizeLtAddress,
  normalizeLvAddress,
  normalizeSeAddress,
} from './geocode-normalizers'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'geocode')

// Geocoder backend. Defaults to the public Nominatim (fine for local dev and
// light use). Set LOCATIONIQ_API_KEY in production to route through LocationIQ,
// which serves the same Nominatim-format JSON but with a proper request quota
// and no shared-IP bans. Optionally override LOCATIONIQ_ENDPOINT (default EU).
const LOCATIONIQ_KEY = process.env.LOCATIONIQ_API_KEY ?? ''
const GEOCODER_BASE = LOCATIONIQ_KEY
  ? (process.env.LOCATIONIQ_ENDPOINT ?? 'https://eu1.locationiq.com/v1/search')
  : 'https://nominatim.openstreetmap.org/search'
// Nominatim policy requires an identifying UA, not a browser imitation.
const UA = 'zvg-immo/1.0 (self-hosted; github.com/haexhub)'

let lastRequestAt = 0
const MIN_GAP_MS = 1100
// Serialises the wait-then-stamp dance across concurrent callers so request
// starts stay MIN_GAP_MS apart (same pattern as server/crawlers/boe/fetch.ts).
let queue: Promise<void> = Promise.resolve()

// Minimal upstream backoff: 403/429 bans and outages surface as `undefined`
// results from geocodeOnce (fetch error / !res.ok / non-JSON body). After 5
// consecutive failures we stop fetching for 15 minutes — geocodeAddress then
// treats cache misses as if fetchMissing=false (skip instead of hammering a
// banned IP). Any successful request resets the counter.
const MAX_CONSECUTIVE_FAILURES = 5
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000
let consecutiveFailures = 0
let cooldownUntil = 0

export interface GeoPoint {
  lat: number
  lng: number
  displayName: string
}

/** Which backend geocodeOnce would currently call. Recorded alongside every
 *  attempt (auctions.geocode_provider) so a later switch between Nominatim
 *  and LocationIQ doesn't get masked by stale failures from the other one —
 *  see docs/plans/2026-08-04-gis-wp3-geocoding-abdeckung.md. */
export function activeGeocoderProvider(): 'nominatim' | 'locationiq' {
  return LOCATIONIQ_KEY ? 'locationiq' : 'nominatim'
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
}

function cacheKey(query: string, country: string): string {
  return createHash('sha1').update(`${country}:${query}`).digest('hex').slice(0, 16)
}

/** Single-read cache lookup: 'hit' (geocoded), 'notFound' (attempted, but
 *  Nominatim had no result — cached to suppress retries) or 'missing' (never
 *  attempted / unreadable). */
async function readCacheEntry(
  query: string,
  country: string,
): Promise<{ state: 'hit' | 'notFound' | 'missing'; point?: GeoPoint }> {
  try {
    const path = join(CACHE_DIR, `${cacheKey(query, country)}.json`)
    const buf = await readFile(path, 'utf8')
    const parsed = JSON.parse(buf)
    if (parsed.notFound) return { state: 'notFound' }
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
      return { state: 'hit', point: parsed }
    }
  } catch {
    // miss
  }
  return { state: 'missing' }
}

async function writeCache(query: string, country: string, value: GeoPoint | null): Promise<void> {
  await ensureCacheDir()
  const path = join(CACHE_DIR, `${cacheKey(query, country)}.json`)
  await writeFile(
    path,
    JSON.stringify(value === null ? { notFound: true, query, country } : { ...value, query, country }),
  )
}

async function rateLimitedFetch(url: string): Promise<Response> {
  // Chain each acquire onto the previous one so concurrent callers serialise
  // instead of racing past the gap check simultaneously.
  const prev = queue
  let release!: () => void
  queue = new Promise<void>((resolve) => {
    release = resolve
  })
  await prev
  const now = Date.now()
  const wait = Math.max(0, lastRequestAt + MIN_GAP_MS - now)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
  release()
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
}

/** Returns the geocode result, or null for "not found", or undefined when the
 *  upstream rejected/erred (don't cache this — retry next time). */
export async function geocodeOnce(query: string, country: string): Promise<GeoPoint | null | undefined> {
  const params = `format=json&limit=1&countrycodes=${country}&q=${encodeURIComponent(query)}`
  const url = `${GEOCODER_BASE}?${params}${LOCATIONIQ_KEY ? `&key=${LOCATIONIQ_KEY}` : ''}`
  let res: Response
  try {
    res = await rateLimitedFetch(url)
  } catch {
    return undefined
  }
  if (!res.ok) {
    // LocationIQ reports "no match" as HTTP 404 with {"error":"Unable to
    // geocode"}, unlike Nominatim's empty 200 array. Treat that as a genuine
    // not-found so it gets cached instead of retried forever (and doesn't count
    // toward the failure cooldown). Any other status is a real upstream error.
    if (LOCATIONIQ_KEY && res.status === 404) return null
    return undefined
  }
  const text = await res.text()
  if (!text.trimStart().startsWith('[')) {
    // Likely an error page like "Access denied" — don't cache.
    return undefined
  }
  let data: Array<{ lat: string; lon: string; display_name: string }>
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(data)) return undefined
  if (data.length === 0) return null
  const hit = data[0]
  if (!hit) return undefined
  const lat = parseFloat(hit.lat)
  const lng = parseFloat(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined
  return { lat, lng, displayName: hit.display_name }
}

export type GeocodeStatus = 'geocoded' | 'unresolvable' | 'pending'

/** Cache-only inspection: has this address been geocoded, tried-and-failed
 *  ("notFound" cached), or never attempted? Used by the client to distinguish
 *  a still-running background geocode from addresses Nominatim can't resolve
 *  at all — the latter must stop the "läuft …" progress spinner. */
export async function geocodeStatus(
  address: string | null,
  country: string,
): Promise<GeocodeStatus> {
  if (!address) return 'unresolvable'
  const c = country.toLowerCase()
  let allAttempted = true
  for (const q of buildGeocodeQueries(address, c)) {
    const cached = await readCacheEntry(q, c)
    if (cached.state === 'hit') return 'geocoded'
    if (cached.state === 'missing') allAttempted = false
  }
  return allAttempted ? 'unresolvable' : 'pending'
}

export async function geocodeAddress(
  address: string | null,
  country: string,
  options: { fetchMissing?: boolean } = { fetchMissing: true },
): Promise<GeoPoint | null> {
  if (!address) return null
  const c = country.toLowerCase()
  // During the failure cooldown a cache miss behaves like fetchMissing=false:
  // serve what's cached but leave Nominatim alone until the ban blows over.
  const fetchMissing = Boolean(options.fetchMissing) && Date.now() >= cooldownUntil
  for (const q of buildGeocodeQueries(address, c)) {
    const cached = await readCacheEntry(q, c)
    if (cached.state === 'hit') return cached.point!
    if (cached.state === 'notFound') continue
    if (!fetchMissing) continue
    const hit = await geocodeOnce(q, c)
    if (hit === undefined) {
      // Upstream error — don't cache, just skip this query and try fallbacks
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      }
      continue
    }
    consecutiveFailures = 0
    await writeCache(q, c, hit)
    if (hit) return hit
  }
  return null
}
