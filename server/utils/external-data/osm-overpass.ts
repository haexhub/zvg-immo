import { type Point } from './geo'
import {
  BUILDING_RADIUS_METERS,
  FERRY_RADIUS_METERS,
  HEAVY_INDUSTRY_RADIUS_METERS,
  PLACE_RADIUS_METERS,
  type OverpassResponse,
} from './osm-location-shared'

const NOISY_ROAD_RADIUS_METERS = 8_000
const MINOR_ROAD_RADIUS_METERS = 5_000
const OFFICE_RADIUS_METERS = 1_500

// 429 is the per-IP quota, 504 the endpoint giving up on a query, and
// 502/503 a busy instance — all transient, all previously fatal for the
// auction being enriched. A network-level failure ('fetch failed') and the
// local timeout abort are retried too: production saw those immediately after
// a burst of 429s, i.e. as the same overload.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
// The client timeout is also what the endpoint receives as `[timeout:]`, so it
// is an upper bound on the query, not just on the wait. Measured server-side
// execution for one auction is ~9 s once the query uses bboxes, but a busy
// instance queues before it starts work; the old 20 s could not even fit the
// pre-bbox 60 s query, which is why every production call returned 504.
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2_000
export const DEFAULT_MAX_ATTEMPTS = 4
export const DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_FAILURES = 5
const BACKOFF_BASE_MS = 5_000
const MAX_BACKOFF_MS = 60_000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serializes callers and keeps at least `minIntervalMs` between releases, so
 *  a run of auctions trickles into the endpoint instead of arriving as a burst
 *  that trips the per-IP quota. */
export function createRequestGate(
  minIntervalMs: number,
  sleepImpl: (ms: number) => Promise<void>,
): () => Promise<void> {
  let previous: Promise<void> = Promise.resolve()
  let lastStartedAt = 0
  return () => {
    const mine = previous.then(async () => {
      const wait = lastStartedAt + minIntervalMs - Date.now()
      if (wait > 0) await sleepImpl(wait)
      lastStartedAt = Date.now()
    })
    previous = mine.catch(() => undefined)
    return mine
  }
}

class OverpassRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message)
    this.name = 'OverpassRequestError'
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OverpassRequestError) {
    return err.status == null || RETRYABLE_STATUSES.has(err.status)
  }
  return true
}

function backoffMs(attempt: number, err: unknown): number {
  const suggested = err instanceof OverpassRequestError ? err.retryAfterMs : null
  // Retry-After is authoritative for 429 — Overpass reports when the slot
  // frees up, and guessing shorter just burns another rejection.
  const base = suggested ?? BACKOFF_BASE_MS * 2 ** (attempt - 1)
  return Math.min(base, MAX_BACKOFF_MS)
}

export async function postOverpassWithRetry(
  endpoint: string,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  opts: { gate: () => Promise<void>; sleepImpl: (ms: number) => Promise<void>; maxAttempts: number },
): Promise<OverpassResponse> {
  let lastError: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    await opts.gate()
    try {
      return await postOverpass(endpoint, query, fetchImpl, timeoutMs)
    } catch (err) {
      lastError = err
      if (attempt === opts.maxAttempts || !isRetryable(err)) throw err
      await opts.sleepImpl(backoffMs(attempt, err))
    }
  }
  throw lastError
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

async function postOverpass(
  endpoint: string,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = new URLSearchParams({ data: query })
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': 'PropHammer location enrichment (contact via deployment operator)',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new OverpassRequestError(
        `Overpass returned ${res.status}`,
        res.status,
        parseRetryAfterMs(res.headers.get('retry-after')),
      )
    }
    const payload = await res.json() as OverpassResponse
    // An overloaded instance also reports a died query as HTTP 200 with a
    // `remark` and whatever it had collected so far. Without this the retry
    // work above is bypassed entirely: the auction is stored as successfully
    // enriched with a truncated or empty element set, which is the silent
    // failure this adapter exists to remove. No status, so isRetryable()
    // treats it as transient.
    if (payload.remark && /runtime error|timed out|out of memory/i.test(payload.remark)) {
      throw new OverpassRequestError(`Overpass runtime error: ${payload.remark}`, null, null)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

/** Bounding box enclosing `radiusMeters` around `point`, as Overpass's
 *  (south,west,north,east) filter.
 *
 *  Selection is by bbox rather than `around:` because `around:` forces a linear
 *  scan while a bbox uses the spatial index. Measured against overpass-api.de
 *  for one Swedish auction, the identical set of sub-queries runs in 8.7 s as
 *  bboxes versus 60.6 s as `around:` — decisive here, because the client
 *  timeout is what the endpoint sees as `[timeout:]`, and a query that cannot
 *  finish inside it can only ever return 504.
 *
 *  A bbox is a superset of the circle (out to the corners, ~1.41x the radius).
 *  That is safe for any consumer applying its own metre threshold, since
 *  distances are computed client-side and the radii here only govern how much
 *  data is fetched. Consumers that assert existence rather than a distance clip
 *  to their own radii in the context builder. */
function bbox(point: Point, radiusMeters: number): string {
  const dLat = radiusMeters / 111_320
  const dLng = radiusMeters / (111_320 * Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01))
  return [point.lat - dLat, point.lng - dLng, point.lat + dLat, point.lng + dLng]
    .map((value) => value.toFixed(6))
    .join(',')
}

// The public Overpass instance bills per-IP by execution time and result size,
// and the original single query blew that budget on every call. The narrowed
// bboxes below match the ranges the context builder actually reads.
export function buildQuery(point: Point, timeoutMs: number): string {
  const overpassTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000))
  const at = (radiusMeters: number) => bbox(point, radiusMeters)
  return `
[out:json][timeout:${overpassTimeoutSec}];
(
  node(${at(PLACE_RADIUS_METERS)})["place"~"^(city|town|suburb|village|hamlet|island|municipality)$"];
  nwr(${at(3000)})["public_transport"~"^(platform|stop_position|station)$"];
  node(${at(3000)})["highway"="bus_stop"];
  nwr(${at(3000)})["railway"~"^(station|halt|tram_stop)$"];
  nwr(${at(FERRY_RADIUS_METERS)})["amenity"="ferry_terminal"];
  nwr(${at(FERRY_RADIUS_METERS)})["route"="ferry"];
  nwr(${at(15000)})["aeroway"~"^(aerodrome|runway|helipad|heliport)$"];
  way(${at(NOISY_ROAD_RADIUS_METERS)})["highway"~"^(motorway|trunk|primary)$"];
  way(${at(MINOR_ROAD_RADIUS_METERS)})["highway"~"^(secondary|tertiary)$"];
  nwr(${at(5000)})["landuse"~"^(industrial|commercial|retail|quarry|landfill|brownfield)$"];
  nwr(${at(HEAVY_INDUSTRY_RADIUS_METERS)})["industrial"];
  nwr(${at(HEAVY_INDUSTRY_RADIUS_METERS)})["man_made"~"^(works|wastewater_plant|petroleum_well|mineshaft)$"];
  nwr(${at(HEAVY_INDUSTRY_RADIUS_METERS)})["power"~"^(plant|generator|substation)$"];
  nwr(${at(5000)})["amenity"~"^(waste_transfer_station|recycling|ferry_terminal)$"];
  nwr(${at(10000)})["amenity"~"^(college|university)$"];
  nwr(${at(OFFICE_RADIUS_METERS)})["office"];
  nwr(${at(BUILDING_RADIUS_METERS)})["building"];
  nwr(${at(5000)})["amenity"~"^(school|kindergarten|college|university|doctors|clinic|hospital|pharmacy|bank|atm|fuel|restaurant|cafe|bar|fast_food|post_office|library|community_centre)$"];
  nwr(${at(5000)})["shop"~"^(supermarket|convenience|bakery|butcher|mall|department_store)$"];
  nwr(${at(5000)})["leisure"~"^(park|sports_centre|playground|fitness_centre|garden)$"];
  nwr(${at(500)})["abandoned"];
  nwr(${at(500)})["disused"];
  nwr(${at(500)})["ruins"];
  nwr(${at(500)})["building"~"^(ruins|collapsed|abandoned)$"];
  nwr(${at(500)})["historic"="ruins"];
);
out center tags;
`.trim()
}
