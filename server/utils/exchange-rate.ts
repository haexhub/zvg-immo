import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'exchange-rates.json')
const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
const TTL_MS = 24 * 60 * 60 * 1000

interface RateCache {
  fetchedAt: string
  rates: Record<string, number>
}

let memory: RateCache | null = null

/** Returns exchange rates: units of each currency per 1 EUR. */
export async function getRates(): Promise<Record<string, number>> {
  if (memory && Date.now() - new Date(memory.fetchedAt).getTime() < TTL_MS) {
    return memory.rates
  }
  try {
    const buf = await readFile(CACHE_PATH, 'utf8')
    const cached: RateCache = JSON.parse(buf)
    if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) {
      memory = cached
      return cached.rates
    }
  } catch {
    // cache miss — fetch fresh below
  }
  return fetchAndCache()
}

/** Converts `amount` in `currency` to EUR, rounded to the nearest integer. */
export function toEur(amount: number, currency: string, rates: Record<string, number>): number | null {
  const rate = rates[currency]
  if (!rate) return null
  return Math.round(amount / rate)
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
