// Geocodes addresses via a Nominatim-compatible backend, with a ~1 req/s rate
// limit and a disk-backed cache so repeat lookups are free.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

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
async function geocodeOnce(query: string, country: string): Promise<GeoPoint | null | undefined> {
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
  if (data.length === 0) return null // genuinely not found — cache this
  const hit = data[0]
  if (!hit) return undefined
  const lat = parseFloat(hit.lat)
  const lng = parseFloat(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined
  return { lat, lng, displayName: hit.display_name }
}

/** Country-specific PLZ + city fallbacks. Tightening the regex per country
 *  avoids false matches across postal-code formats. */
const POSTAL_PATTERNS: Record<string, RegExp> = {
  de: /(\d{5})\s+([^,]+?)(?:,|$)/,
  at: /(\d{4})\s+([^,]+?)(?:,|$)/,
  be: /(\d{4})\s+([^,]+?)(?:,|$)/,
  es: /(\d{5})\s+([^,]+?)(?:,|$)/,
  it: /(\d{5})\s+([^,]+?)(?:,|$)/,
  cz: /(\d{3}\s?\d{2})\s+([^,]+?)(?:,|$)/,
  pl: /(\d{2}-\d{3})\s+([^,]+?)(?:,|$)/,
  hu: /(\d{4})\s+([^,]+?)(?:,|$)/,
}

// Country names appended to addresses that break Nominatim lookups despite
// countrycodes= already restricting the search to the right country.
const STRIP_COUNTRY_SUFFIX: Record<string, string> = {
  hu: 'Ungarn',
}

// --- Lithuania (eaukcionai.lt) ---------------------------------------------
// LT addresses come as a chain of genitive administrative units plus a street,
// e.g. "Klaipėdos m. sav. Klaipėdos m. Naujakiemio g. 25-57". Nominatim can't
// parse that, but it resolves the reduced form "<street> g. <house>, <city>"
// (the genitive city name is fine; only the admin prefixes and the apartment
// suffix need removing). Addresses without a street collapse to
// "<locality>, <district>".
const LT_ADMIN = new Set(['sav.', 'r.', 'raj.', 'm.', 'k.', 'mstl.', 'sen.', 'vs.', 'apskr.'])
const LT_STREET = new Set(['g.', 'pr.', 'al.', 'pl.', 'skg.', 'kel.'])
const LT_LOCALITY = new Set(['m.', 'k.', 'mstl.', 'vs.'])

export function normalizeLtAddress(address: string): string[] {
  const tokens = address.split(' ').filter(Boolean)
  const streetIdx = tokens.findIndex((t) => LT_STREET.has(t))
  const out: string[] = []

  if (streetIdx > 0 && streetIdx < tokens.length - 1) {
    // Drop the apartment part of the house number ("25-57" → "25").
    const houseNr = tokens[streetIdx + 1]!.split('-')[0]!
    // Street name = the words between the last admin marker and the street type.
    let i = streetIdx - 1
    const parts: string[] = []
    while (i >= 0 && !LT_ADMIN.has(tokens[i]!)) parts.unshift(tokens[i--]!)
    const street = `${parts.join(' ')} ${tokens[streetIdx]} ${houseNr}`.trim()
    // The city is the place name right before that admin marker.
    const city = i >= 1 ? tokens[i - 1] : ''
    if (city) {
      out.push(`${street}, ${city}`)
      out.push(city) // fallback: at least land in the right city
    } else {
      out.push(street)
    }
  } else {
    // No street — use the smallest locality plus the district for context.
    let localityIdx = -1
    for (let k = 0; k < tokens.length; k++) if (LT_LOCALITY.has(tokens[k]!)) localityIdx = k
    const locality = localityIdx >= 1 ? tokens[localityIdx - 1] : ''
    const district = tokens[0] && !LT_ADMIN.has(tokens[0]) ? tokens[0] : ''
    if (locality && district) {
      out.push(`${locality}, ${district}`)
      out.push(locality)
    } else if (locality) {
      out.push(locality)
    }
  }

  return out.length > 0 ? [...new Set(out)] : [address]
}

/**
 * Normalises an address into a Nominatim-friendly query, optionally falling
 * back to PLZ+city if the full address fails to resolve.
 */
function buildQueries(address: string, country: string): string[] {
  const cleaned = address.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  // Lithuanian addresses need structural rewriting, not just suffix handling.
  if (country === 'lt') return normalizeLtAddress(cleaned)
  // Strip trailing country name for countries where it confuses Nominatim.
  // countrycodes= already restricts the search, so the name is redundant.
  const suffix = STRIP_COUNTRY_SUFFIX[country]
  const base = suffix ? cleaned.replace(new RegExp(`,\\s*${suffix}\\s*$`), '').trim() : cleaned
  const queries = [base]
  const pattern = POSTAL_PATTERNS[country]
  if (pattern) {
    const m = base.match(pattern)
    if (m) {
      const fallback = `${m[1]} ${m[2]}`.trim()
      if (fallback !== base) queries.push(fallback)
    }
  }
  return queries
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
  for (const q of buildQueries(address, c)) {
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
  for (const q of buildQueries(address, c)) {
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
