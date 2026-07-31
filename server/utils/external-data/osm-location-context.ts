import type { Auction } from '~/types/auction'
import type { LocationContextAdapter } from '~/server/tasks/external-enrichment'
import { type Point } from './geo'
import { buildLocationContext } from './osm-location-context-builder'
import {
  DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_GIVE_UP_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  buildQuery,
  createRequestGate,
  postOverpassWithRetry,
  sleep,
} from './osm-overpass'

export { buildLocationContext }

export interface OsmLocationContextOptions {
  endpoint: string
  checkedAt: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Minimum spacing between requests from this adapter instance. */
  minRequestIntervalMs?: number
  /** Total attempts per auction, including the first. */
  maxAttempts?: number
  /** Injectable so tests exercise the backoff without real delays. */
  sleepImpl?: (ms: number) => Promise<void>
  /** Consecutive fully-failed auctions after which the run stops trying. */
  giveUpAfterConsecutiveFailures?: number
  /** How long to pause once giveUpAfterConsecutiveFailures trips before
   *  probing the endpoint again. */
  giveUpCooldownMs?: number
  /** Injectable so tests exercise the cooldown without a real wait. */
  nowImpl?: () => number
}

export function createOsmLocationContextAdapter(options: OsmLocationContextOptions): LocationContextAdapter {
  const endpoint = options.endpoint.trim()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl = options.sleepImpl ?? sleep
  // One gate per adapter instance. external-enrichment.ts builds the adapter
  // once per run and walks auctions sequentially, so spacing requests here
  // paces the whole run.
  const gate = createRequestGate(options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS, sleepImpl)
  const giveUpAfter = options.giveUpAfterConsecutiveFailures ?? DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_FAILURES
  const giveUpCooldownMs = options.giveUpCooldownMs ?? DEFAULT_GIVE_UP_COOLDOWN_MS
  const now = options.nowImpl ?? Date.now
  // Retrying with backoff turns a hard endpoint block into a very long run
  // (every auction burning its full attempt budget). Once this many auctions
  // in a row have exhausted their retries the endpoint is refusing us
  // wholesale, so stop paying for it — but only for giveUpCooldownMs, not the
  // rest of the run. Without the cooldown, a blip that clears a minute later
  // would still cost every auction that happens to come after it in this
  // run's iteration order, not just the ones that actually failed.
  let consecutiveFailures = 0
  let cooldownUntil = 0
  return {
    id: 'osm-location-context',
    sourceVersion: 'osm-overpass-v1',
    supports: (auction) => !!endpoint && isFinitePoint(auction),
    async context(auction) {
      if (now() < cooldownUntil) {
        throw new Error(`Overpass unavailable, in cooldown after ${consecutiveFailures} consecutive failures`)
      }
      const point = { lat: auction.lat!, lng: auction.lng! }
      try {
        const response = await postOverpassWithRetry(
          endpoint,
          buildQuery(point, timeoutMs),
          fetchImpl,
          timeoutMs,
          { gate, sleepImpl, maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS },
        )
        consecutiveFailures = 0
        return buildLocationContext(point, response.elements ?? [], options.checkedAt)
      } catch (err) {
        consecutiveFailures++
        if (consecutiveFailures >= giveUpAfter) {
          cooldownUntil = now() + giveUpCooldownMs
        }
        throw err
      }
    },
  }
}

function isFinitePoint(auction: Auction): boolean {
  return Number.isFinite(auction.lat) && Number.isFinite(auction.lng)
}
