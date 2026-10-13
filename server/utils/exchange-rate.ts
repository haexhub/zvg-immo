import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Auction } from '~/types/auction'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'exchange-rates.json')
const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
const TTL_MS = 24 * 60 * 60 * 1000
// After a failed live fetch falls back to a stale cache entry, wait this
// long before retrying ECB again instead of re-attempting on every request.
const RETRY_COOLDOWN_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

// Currencies pegged to EUR at a fixed rate that the ECB reference-rate feed
// doesn't publish (too minor to be in its ~30-currency list). Merged into
// every getRates() result so toEur() works for them like any ECB-fed currency.
const PEGGED_RATES: Record<string, number> = {
  // BAM (Bosnia-Herzegovina Konvertibilna marka), fixed by the BiH Currency Board.
  BAM: 1.95583,
}

// Currencies the crawlers price in (server/crawlers/*). A 200 response that
// lacks any of them (maintenance page, changed XML) must not replace a good
// cache for 24 h, so it is rejected and getRates() falls back to stale rates.
// ponytail: hard-coded list; if ECB ever stops publishing one of these (euro
// adoption), drop it here together with the crawler's currency.
const REQUIRED_ECB_CURRENCIES = ['CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'SEK', 'USD']

interface RateCache {
  fetchedAt: string
  rates: Record<string, number>
}

let memory: RateCache | null = null
// Timestamp of the last failed live fetch that fell back to `memory` holding
// a stale entry. Kept separate from `memory.fetchedAt` so a served-stale
// entry isn't mistaken for a fresh one, while still gating retries.
let staleSince: number | null = null

/** Returns exchange rates: units of each currency per 1 EUR. */
export async function getRates(): Promise<Record<string, number>> {
  if (memory) {
    const fresh = Date.now() - new Date(memory.fetchedAt).getTime() < TTL_MS
    const withinRetryCooldown = staleSince !== null && Date.now() - staleSince < RETRY_COOLDOWN_MS
    if (fresh || withinRetryCooldown) {
      return { ...PEGGED_RATES, ...memory.rates }
    }
  }
  let stale: RateCache | null = null
  try {
    const buf = await readFile(CACHE_PATH, 'utf8')
    const cached: RateCache = JSON.parse(buf)
    if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) {
      memory = cached
      staleSince = null
      return { ...PEGGED_RATES, ...cached.rates }
    }
    stale = cached // expired, but kept as a fallback below
  } catch {
    // cache miss — fetch fresh below
  }
  try {
    const rates = await fetchAndCache()
    staleSince = null
    return { ...PEGGED_RATES, ...rates }
  } catch (err) {
    // ECB unreachable/erroring (or timed out, see FETCH_TIMEOUT_MS) — serve
    // the last known rates rather than failing every request until it
    // recovers, retrying only after RETRY_COOLDOWN_MS instead of on every
    // call. No fallback available on a cold cache (first-ever run), so that
    // case still throws.
    if (stale) {
      console.warn(`[exchange-rate] live fetch failed, serving stale cache from ${stale.fetchedAt}: ${(err as Error).message}`)
      memory = stale
      staleSince = Date.now()
      return { ...PEGGED_RATES, ...stale.rates }
    }
    throw err
  }
}

/** Converts `amount` in `currency` to EUR, rounded to the nearest integer. */
export function toEur(amount: number, currency: string, rates: Record<string, number>): number | null {
  const rate = rates[currency]
  if (!rate) return null
  return Math.round(amount / rate)
}

/**
 * Fills `marketValueEur` from `marketValue`+`currency` — the single place
 * that turns a crawler's native value into the cross-country EUR figure used
 * for sorting/filtering. Applied to every auction after crawl (registry.ts)
 * and again after enrichOne (enrich.ts), since a few platforms (HU, PL) only
 * learn the value on the detail page.
 *
 * EUR-native crawlers never set `currency` and keep assigning
 * `marketValueEur` directly (unchanged, Phase A behavior) — this backfills
 * `marketValue`/`currency` from that so both models agree.
 */
export function deriveMarketValueEur(auction: Auction, rates: Record<string, number>, previous?: Auction): void {
  if (auction.currency == null) {
    if (auction.marketValueEur != null) {
      auction.currency = 'EUR'
      auction.marketValue ??= auction.marketValueEur
    }
    return
  }
  auction.marketValueEur =
    auction.currency === 'EUR'
      ? (auction.marketValue ?? null)
      : auction.marketValue != null
        ? (toEur(auction.marketValue, auction.currency, rates) ?? storedEurConversion(auction, previous))
        : null
}

/**
 * The stored EUR figure for an auction whose native value could not be
 * converted (no rate, see loadRatesOrPegged), as long as the stored snapshot
 * converted the very same amount and currency. Persisting null instead would
 * drop every foreign auction out of price filters, sorting and alerts until
 * ECB answers again.
 */
export function storedEurConversion(auction: Auction, previous: Auction | undefined): number | null {
  if (previous == null || previous.currency !== auction.currency || previous.marketValue !== auction.marketValue) return null
  return previous.marketValueEur
}

/**
 * getRates() for batch callers (crawl, enrich) that must not fail as a whole
 * when no rates exist yet: a cold cache plus an ECB outage falls back to the
 * pegged currencies only, leaving every other foreign value unconverted
 * (marketValueEur null) instead of discarding already-crawled auctions —
 * including pure-EUR ones — until ECB answers again.
 */
export async function loadRatesOrPegged(): Promise<Record<string, number>> {
  try {
    return await getRates()
  } catch (err) {
    console.warn(`[exchange-rate] no rates available, leaving non-EUR values unconverted: ${(err as Error).message}`)
    return { ...PEGGED_RATES }
  }
}

/** deriveMarketValueEur for a whole crawl batch; ECB rates are only loaded
 *  when some auction carries a non-EUR currency. */
export async function deriveMarketValuesEur(auctions: readonly Auction[]): Promise<void> {
  const rates = auctions.some((a) => a.currency != null && a.currency !== 'EUR')
    ? await loadRatesOrPegged()
    : { ...PEGGED_RATES }
  for (const a of auctions) deriveMarketValueEur(a, rates)
}

async function fetchAndCache(): Promise<Record<string, number>> {
  const res = await fetch(ECB_URL, {
    headers: { 'User-Agent': 'zvg-immo/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ECB rate fetch failed: ${res.status}`)
  const xml = await res.text()
  const rates: Record<string, number> = {}
  const re = /currency='([A-Z]+)'\s+rate='([0-9.]+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const rate = parseFloat(m[2]!)
    if (Number.isFinite(rate) && rate > 0) rates[m[1]!] = rate
  }
  const missing = REQUIRED_ECB_CURRENCIES.filter((currency) => rates[currency] === undefined)
  if (missing.length) throw new Error(`ECB rate feed is missing ${missing.join(', ')}`)
  const entry: RateCache = { fetchedAt: new Date().toISOString(), rates }
  memory = entry
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8')
  return rates
}
