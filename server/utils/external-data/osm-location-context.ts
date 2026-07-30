import type { Auction } from '~/types/auction'
import type { LocationContextAdapter } from '~/server/tasks/external-enrichment'
import { type Point } from './geo'
import { buildLocationContext } from './osm-location-context-builder'
import {
  DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_FAILURES,
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
  // Retrying with backoff turns a hard endpoint block into a very long run
  // (every auction burning its full attempt budget), which would overlap the
  // next scheduled tick. Once this many auctions in a row have exhausted their
  // retries the endpoint is refusing us wholesale, so stop paying for it and
  // let the run finish — the next tick starts with a clean counter.
  let consecutiveFailures = 0
  return {
    id: 'osm-location-context',
    sourceVersion: 'osm-overpass-v1',
    supports: (auction) => !!endpoint && isFinitePoint(auction),
    async context(auction) {
      if (consecutiveFailures >= giveUpAfter) {
        throw new Error(`Overpass unavailable, skipped after ${consecutiveFailures} consecutive failures`)
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
        throw err
      }
    },
  }
}

function isFinitePoint(auction: Auction): boolean {
  return Number.isFinite(auction.lat) && Number.isFinite(auction.lng)
}
