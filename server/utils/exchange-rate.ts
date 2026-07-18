import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Auction } from '~/types/auction'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'exchange-rates.json')
const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
const TTL_MS = 24 * 60 * 60 * 1000

// Currencies pegged to EUR at a fixed rate that the ECB reference-rate feed
// doesn't publish (too minor to be in its ~30-currency list). Merged into
// every getRates() result so toEur() works for them like any ECB-fed currency.
const PEGGED_RATES: Record<string, number> = {
  // BAM (Bosnia-Herzegovina Konvertibilna marka), fixed by the BiH Currency Board.
  BAM: 1.95583,
}

interface RateCache {
  fetchedAt: string
  rates: Record<string, number>
}

let memory: RateCache | null = null

/** Returns exchange rates: units of each currency per 1 EUR. */
export async function getRates(): Promise<Record<string, number>> {
  if (memory && Date.now() - new Date(memory.fetchedAt).getTime() < TTL_MS) {
    return { ...PEGGED_RATES, ...memory.rates }
  }
  try {
    const buf = await readFile(CACHE_PATH, 'utf8')
    const cached: RateCache = JSON.parse(buf)
    if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) {
      memory = cached
      return { ...PEGGED_RATES, ...cached.rates }
    }
  } catch {
    // cache miss — fetch fresh below
  }
  return { ...PEGGED_RATES, ...(await fetchAndCache()) }
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
export function deriveMarketValueEur(auction: Auction, rates: Record<string, number>): void {
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
        ? toEur(auction.marketValue, auction.currency, rates)
        : null
}

async function fetchAndCache(): Promise<Record<string, number>> {
  const res = await fetch(ECB_URL, { headers: { 'User-Agent': 'zvg-immo/1.0' } })
  if (!res.ok) throw new Error(`ECB rate fetch failed: ${res.status}`)
  const xml = await res.text()
  const rates: Record<string, number> = {}
  const re = /currency='([A-Z]+)'\s+rate='([0-9.]+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    rates[m[1]!] = parseFloat(m[2]!)
  }
  const entry: RateCache = { fetchedAt: new Date().toISOString(), rates }
  memory = entry
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8')
  return rates
}
