// Geocodes addresses via OpenStreetMap Nominatim, with strict 1 req/s rate
// limit (per Nominatim policy) and a disk-backed cache so repeat lookups are free.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'geocode')
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'
const UA = 'Mozilla/5.0 (compatible; ZVG-Sachsen-DemoApp/1.0)'

let lastRequestAt = 0
const MIN_GAP_MS = 1100

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

async function readCache(query: string, country: string): Promise<GeoPoint | null> {
  try {
    const path = join(CACHE_DIR, `${cacheKey(query, country)}.json`)
    const buf = await readFile(path, 'utf8')
    const parsed = JSON.parse(buf)
    if (parsed.notFound) return null
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') return parsed
  } catch {
    // miss
  }
  return null
}

async function writeCache(query: string, country: string, value: GeoPoint | null): Promise<void> {
  await ensureCacheDir()
  const path = join(CACHE_DIR, `${cacheKey(query, country)}.json`)
  await writeFile(
    path,
    JSON.stringify(value === null ? { notFound: true, query, country } : { ...value, query, country }),
  )
}

async function cacheHasKey(query: string, country: string): Promise<boolean> {
  try {
    await stat(join(CACHE_DIR, `${cacheKey(query, country)}.json`))
    return true
  } catch {
    return false
  }
}

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now()
  const wait = Math.max(0, lastRequestAt + MIN_GAP_MS - now)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
}

/** Returns the geocode result, or null for "not found", or undefined when the
 *  upstream rejected/erred (don't cache this — retry next time). */
async function geocodeOnce(query: string, country: string): Promise<GeoPoint | null | undefined> {
  const url = `${NOMINATIM_BASE}?format=json&limit=1&countrycodes=${country}&q=${encodeURIComponent(query)}`
  let res: Response
  try {
    res = await rateLimitedFetch(url)
  } catch {
    return undefined
  }
  if (!res.ok) return undefined
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
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    displayName: hit.display_name,
  }
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
}

/**
 * Normalises an address into a Nominatim-friendly query, optionally falling
 * back to PLZ+city if the full address fails to resolve.
 */
function buildQueries(address: string, country: string): string[] {
  const cleaned = address.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  const queries = [cleaned]
  const pattern = POSTAL_PATTERNS[country]
  if (pattern) {
    const m = cleaned.match(pattern)
    if (m) {
      const fallback = `${m[1]} ${m[2]}`.trim()
      if (fallback !== cleaned) queries.push(fallback)
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
    const cached = await readCache(q, c)
    if (cached) return 'geocoded'
    if (!(await cacheHasKey(q, c))) allAttempted = false
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
  for (const q of buildQueries(address, c)) {
    const cached = await readCache(q, c)
    if (cached) return cached
    if (await cacheHasKey(q, c)) continue // cached as not-found
    if (!options.fetchMissing) continue
    const hit = await geocodeOnce(q, c)
    if (hit === undefined) {
      // Upstream error — don't cache, just skip this query and try fallbacks
      continue
    }
    await writeCache(q, c, hit)
    if (hit) return hit
  }
  return null
}
