// Geocodes German addresses via OpenStreetMap Nominatim, with strict 1 req/s rate
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

function cacheKey(query: string): string {
  return createHash('sha1').update(query).digest('hex').slice(0, 16)
}

async function readCache(query: string): Promise<GeoPoint | null> {
  try {
    const path = join(CACHE_DIR, `${cacheKey(query)}.json`)
    const buf = await readFile(path, 'utf8')
    const parsed = JSON.parse(buf)
    if (parsed.notFound) return null
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') return parsed
  } catch {
    // miss
  }
  return null
}

async function writeCache(query: string, value: GeoPoint | null): Promise<void> {
  await ensureCacheDir()
  const path = join(CACHE_DIR, `${cacheKey(query)}.json`)
  await writeFile(
    path,
    JSON.stringify(value === null ? { notFound: true, query } : { ...value, query }),
  )
}

async function cacheHasKey(query: string): Promise<boolean> {
  try {
    await stat(join(CACHE_DIR, `${cacheKey(query)}.json`))
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
async function geocodeOnce(query: string): Promise<GeoPoint | null | undefined> {
  const url = `${NOMINATIM_BASE}?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(query)}`
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
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    displayName: hit.display_name,
  }
}

/**
 * Normalises a "Otzdorfer Straße 30, 04736 Waldheim" address into a Nominatim-friendly
 * query, optionally falling back to PLZ+city if the full address fails to resolve.
 */
function buildQueries(address: string): string[] {
  const cleaned = address.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  const queries = [cleaned]
  // Fallback: drop street & house number, keep PLZ + city
  const m = cleaned.match(/(\d{5})\s+([^,]+?)(?:,|$)/)
  if (m) {
    const fallback = `${m[1]} ${m[2]}`.trim()
    if (fallback !== cleaned) queries.push(fallback)
  }
  return queries
}

export async function geocodeAddress(
  address: string | null,
  options: { fetchMissing?: boolean } = { fetchMissing: true },
): Promise<GeoPoint | null> {
  if (!address) return null
  for (const q of buildQueries(address)) {
    const cached = await readCache(q)
    if (cached) return cached
    if (await cacheHasKey(q)) continue // cached as not-found
    if (!options.fetchMissing) continue
    const hit = await geocodeOnce(q)
    if (hit === undefined) {
      // Upstream error — don't cache, just skip this query and try fallbacks
      continue
    }
    await writeCache(q, hit)
    if (hit) return hit
  }
  return null
}
