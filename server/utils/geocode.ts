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
  se: /(\d{3}\s?\d{2})\s+([^,]+?)(?:,|$)/,
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

// --- Estonia (oksjonikeskus.ee) ---------------------------------------------
// EE addresses chain admin units before the street, like LT — but unlike LT,
// keeping the street-type abbreviation ("tn", "mnt", "pst") breaks the match;
// OSM stores the bare street name. Streetless rural addresses put the specific
// building/farm name *after* the locality chain (comma-separated), not before it.
const EE_STREET_TOKENS = new Set(['tn', 'mnt', 'pst', 'tee', 'tänav', 'puiestee', 'maantee', 'põik'])
const EE_STREET_SUFFIXES = ['maantee', 'puiestee', 'tänav']
const EE_LOCALITY_SUFFIXES = ['linnaosa', 'alevik', 'alev', 'küla', 'linn']
const EE_ADMIN_SUFFIXES = ['vald', 'maakond']

/** A street-type token is either its own word ("tn", "tee" — the street name
 *  sits before it as separate words) or fused onto the street name itself
 *  ("Keskpuiestee" = "Kesk" + "puiestee" — no separate street-name word). */
function matchEeStreetToken(token: string): { exact: boolean; prefix: string } | null {
  if (EE_STREET_TOKENS.has(token)) return { exact: true, prefix: '' }
  const suffix = EE_STREET_SUFFIXES.find((s) => token.length > s.length && token.endsWith(s))
  return suffix ? { exact: false, prefix: token.slice(0, token.length - suffix.length) } : null
}

/** Scans tokens[0..beforeIdx) backwards for the closest token matching one of
 *  `suffixes`, either a standalone marker word (place name = preceding token)
 *  or a compound ending in it (place name = the token itself, e.g. "Tallinn"
 *  ends in "linn", "Mõisaküla" ends in "küla"). */
function findEeMarker(
  tokens: string[],
  beforeIdx: number,
  suffixes: string[],
): { name: string; idx: number } | null {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const token = tokens[i]!
    const suffix = suffixes.find((s) => token === s || (token.length > s.length && token.endsWith(s)))
    if (!suffix) continue
    if (token === suffix) return i > 0 ? { name: tokens[i - 1]!, idx: i } : null
    return { name: token, idx: i }
  }
  return null
}

export function normalizeEeAddress(address: string): string[] {
  const first = address.split(';')[0]!.trim()
  const noCommas = first.replace(/,/g, '')
  const tokens = noCommas.split(' ').filter(Boolean)
  const streetIdx = tokens.findIndex((t) => matchEeStreetToken(t) !== null)
  const streetMatch = streetIdx >= 0 ? matchEeStreetToken(tokens[streetIdx]!) : null
  const out: string[] = []

  if (streetMatch && streetIdx < tokens.length - 1) {
    const houseNr = tokens[streetIdx + 1]!.split(/[-–]/)[0]!
    // Exact street-type words ("tn") sit after a separate street-name word,
    // which must not be mistaken for a locality — skip it in the marker search.
    // Fused street types ("Keskpuiestee") have no such word to skip.
    const searchBefore = streetMatch.exact ? streetIdx - 1 : streetIdx
    const locality = findEeMarker(tokens, searchBefore, [...EE_LOCALITY_SUFFIXES, ...EE_ADMIN_SUFFIXES])
    const outer = locality ? findEeMarker(tokens, locality.idx, EE_ADMIN_SUFFIXES) : null
    const streetCandidates = streetMatch.exact
      ? [tokens.slice(locality ? locality.idx + 1 : 0, streetIdx).join(' ')]
      : [streetMatch.prefix, tokens[streetIdx]!].filter(Boolean)

    for (const street of streetCandidates) {
      if (!street) continue
      if (locality) {
        out.push(`${street} ${houseNr}, ${locality.name}`)
        if (outer && outer.name !== locality.name) out.push(`${street} ${houseNr}, ${outer.name}`)
      }
      out.push(`${street} ${houseNr}`)
    }
  } else {
    // No street: the last comma segment is the specific building/farm name,
    // the locality is the nearest admin marker before it.
    const commaIdx = first.lastIndexOf(',')
    const place = commaIdx >= 0 ? first.slice(commaIdx + 1).trim() : ''
    const chainTokens = (commaIdx >= 0 ? first.slice(0, commaIdx) : first)
      .replace(/,/g, '')
      .split(' ')
      .filter(Boolean)
    const locality = findEeMarker(chainTokens, chainTokens.length, [
      ...EE_LOCALITY_SUFFIXES,
      ...EE_ADMIN_SUFFIXES,
    ])
    if (place && locality) out.push(`${place}, ${locality.name}`)
    if (locality) out.push(locality.name)
    if (place) out.push(place)
  }

  return out.length > 0 ? [...new Set(out)] : [address]
}

// --- Latvia (izsoles.ta.gov.lv) ---------------------------------------------
// LV street addresses are already close to Nominatim-friendly ("<street> iela
// <house>, <city>, <district> novads"). The failures are legal/procedural
// boilerplate wrapped around the address, quoted farmstead names, apartment
// building-block suffixes ("- k-4-36"), and multi-property listings joined by ";".
const LV_PREFIX_PATTERNS: RegExp[] = [
  /^Apbūves tiesības uz zemes vienības daļu\s+/i,
  /^\d+\/\d+\s+d\.d\.\s+no\s+/i,
  /^\d+\/\d+\s+domājamā daļa\s+no\s+/i,
  /^\d+\s+Nekustamo īpašumu kopums,?\s*kas atrodas\s+/i,
  /^dzīvokļa īpašuma\s+/i,
  /^dzīvokļa īpašums\s+/i,
  /^Nekustamā īpašuma\s*[–-]?\s*/i,
  /^Nekustamais īpašums\s*[–-]?\s*(?:dzīvoklis\s+Nr\.?\s*\d+\s*)?/i,
  /^Neapbūvēta zemesgabala\s+/i,
  /^Nomas tiesības uz nekustamo īpašumu\s+/i,
  /^Talsu novada pašvaldība rīko nekustamā īpašuma\s*[–-]?\s*/i,
  /^Savstarpēji saistīti nekustami īpašumu\s+/i,
]

// \w doesn't match Latvian diacritics (ā, š, ē, ...), so word-ending
// alternations are spelled out explicitly instead of using \w*.
const LV_SUFFIX_PATTERNS: RegExp[] = [
  /,?\s*(?:nomas tiesīb[au]\s+)?(?:trešo\s+)?elektronisk[aāuo]\s+izsol[eiu]\.?$/i,
  /\s+izsole\.?$/i,
  /\s+atsavināšana\.?$/i,
  // Cadastral reference numbers are internal IDs, not part of the address.
  /,?\s*kadastra\s*(?:numurs|nr\.?)\s*[\d\s]+\.?$/i,
]

function stripLvBoilerplate(address: string): string {
  let out = address
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of LV_PREFIX_PATTERNS) {
      if (pattern.test(out)) {
        out = out.replace(pattern, '')
        changed = true
      }
    }
  }
  for (const pattern of LV_SUFFIX_PATTERNS) out = out.replace(pattern, '')
  // Trailing ownership-share parenthetical, e.g. "(1/2 domājamā daļa)".
  return out.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

// Quotes wrap farmstead/property names ("Akoti", „Jaunkaņepjvērpji", ,,Jasmīni")
// instead of a street — noise for Nominatim, strip them all. Spelled out as
// explicit code points (not typed literals) since visually-similar smart
// quotes are easy to collapse into duplicates when typed inline.
const LV_QUOTE_CHARS = /["'`‘’“”„]/g
function stripLvQuotes(address: string): string {
  return address.replace(/,,(\S)/g, '$1').replace(LV_QUOTE_CHARS, '')
}

// Apartment/building-block suffixes after the house number confuse Nominatim's
// house-number match; keep only the base number ("260- k-4-36" → "260").
function stripLvUnitSuffix(core: string): string {
  return core
    .replace(/\s*[-–]?\s*k-\d+(?:[\s-–]*\d+)?/gi, '')
    .replace(/(\d+[A-Za-zĀ-Žā-ž]?)\s*[-–]\s*\d+[A-Za-zĀ-Žā-ž]?\s*$/, '$1')
    .trim()
}

// The dotted abbreviations ("pag.", "nov.") aren't just shorthand to Nominatim —
// verified live that the literal abbreviated form fails to match while the full
// word ("pagasts", "novads") resolves the same query, so expand unconditionally.
function expandLvAdminAbbrev(s: string): string {
  return s.replace(/\bpag\.(?=\s|,|$)/gi, 'pagasts').replace(/\bnov\.(?=\s|,|$)/gi, 'novads')
}

export function normalizeLvAddress(address: string): string[] {
  // Usually every ";"-joined segment is a complete, independent address
  // (a multi-property listing) — take the first. But some entries repeat the
  // bare property name before the real, comma-structured address ("Meža
  // Būmeistari; "Meža Būmeistari", Nīcas pag., ..."); prefer whichever segment
  // actually carries locality context over a bare fragment.
  const segments = address.split(';').map((s) => s.trim())
  const first = (segments.find((s) => s.includes(',')) ?? segments[0]!).trim()
  const cleaned = expandLvAdminAbbrev(stripLvQuotes(stripLvBoilerplate(first)))
  if (!cleaned) return [address]

  const commaIdx = cleaned.indexOf(',')
  const core = commaIdx >= 0 ? cleaned.slice(0, commaIdx) : cleaned
  const rest = commaIdx >= 0 ? cleaned.slice(commaIdx + 1).trim() : ''
  const strippedCore = stripLvUnitSuffix(core)

  const out: string[] = []
  out.push(rest ? `${strippedCore}, ${rest}` : strippedCore)
  if (strippedCore !== core) out.push(rest ? `${core}, ${rest}` : core)

  // Locative case ("pagastā", "novadā") is left as-is — only the dotted
  // abbreviation was confirmed broken, not the grammatical case.
  const parishMatch = cleaned.match(/(\S+)\s+(pagast[sā])/i)
  if (parishMatch) out.push(`${parishMatch[1]} ${parishMatch[2]}`)
  const districtMatch = cleaned.match(/(\S+)\s+(novad[sā])/i)
  if (districtMatch) out.push(`${districtMatch[1]} ${districtMatch[2]}`)

  return out.length > 0 ? [...new Set(out)] : [address]
}

// --- Sweden (kronofogden.se) -------------------------------------------------
// SE listings often carry "street, locality, municipality kommun" rather than
// a postal address. Nominatim can miss the full form but resolve the locality
// or municipality, which is preferable to dropping the auction from the map.
function stripSeMissingAddressMarker(address: string): string {
  return address
    .replace(/^\s*adress\s+saknas\s*\/\s*/i, '')
    .replace(/\badress\s+saknas\b\s*\/?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function seMunicipalityCandidates(value: string): string[] {
  const base = value.replace(/\s+kommun$/i, '').trim()
  if (!base) return []
  const candidates = [base]
  // Several municipality labels are genitive ("Bodens kommun" -> "Boden"),
  // while names like "Borås kommun" genuinely end in s. Try both.
  if (base.endsWith('s') && !/(?:fors|ås)$/i.test(base)) candidates.push(base.slice(0, -1))
  return [...new Set(candidates)]
}

export function normalizeSeAddress(address: string): string[] {
  const cleaned = stripSeMissingAddressMarker(address.replace(/\s*,\s*/g, ', '))
  if (!cleaned) return [address]

  const parts = cleaned
    .split(',')
    .map((part) => stripSeMissingAddressMarker(part).trim())
    .filter(Boolean)
  if (parts.length === 0) return [address]

  const last = parts[parts.length - 1]!
  const municipalityCandidates = /\bkommun$/i.test(last) ? seMunicipalityCandidates(last) : []
  const locality = parts.length >= 2
    ? (municipalityCandidates.length ? parts[parts.length - 2] : parts[parts.length - 1])
    : null
  const addressParts = municipalityCandidates.length ? parts.slice(0, -2) : parts.slice(0, -1)
  const streetCandidates = addressParts.length > 0
    ? addressParts.flatMap((part) => part.split('/').map((s) => s.trim()).filter(Boolean))
    : []

  const out: string[] = [cleaned]
  if (municipalityCandidates.length) {
    out.push([...parts.slice(0, -1), municipalityCandidates[0]].join(', '))
  }
  if (locality) {
    for (const street of streetCandidates) {
      out.push(`${street}, ${locality}`)
      for (const municipality of municipalityCandidates) out.push(`${street}, ${municipality}`)
    }
    for (const municipality of municipalityCandidates) out.push(`${locality}, ${municipality}`)
    out.push(locality)
  }
  out.push(...municipalityCandidates)

  return [...new Set(out)]
}

// --- Bulgaria (zapori.mjs.bg) -----------------------------------------------
// parseBgAddress() (server/crawlers/bg/text.ts) composes addresses like
// "ул. ОБОРИЩЕ № 90, гр. БУРГАС, Bulgarien" or "с. МЕДОВО, Bulgarien" — the
// "гр."/"с." (city/village) and "ул."/"бул."/"кв." (street/boulevard/quarter)
// markers plus "№" are Bulgarian conventions Nominatim's BG data never uses
// literally; verified live that leaving them in returns zero results while
// the bare names resolve. A city-only fallback also covers listings where the
// precise street can't be pinned.
const BG_CITY_RE = /(?:гр\.|с\.)\s*([^,]+)/
const BG_STREET_RE = /(?:ул|бул|кв)\.\s*"?([^"\n,№]+?)"?\s*№\s*(\d+[a-zA-Zа-яА-Я]?)/
// parseBgAddress() carries over the „low-high“ quotes titles wrap street
// names in ("кв. „РУСАЛКА“ № 70") — noise for Nominatim, strip them.
const BG_QUOTE_CHARS = /["'„“”‘’]/g

export function normalizeBgAddress(address: string): string[] {
  const city = address.match(BG_CITY_RE)?.[1]?.trim()
  const street = address.match(BG_STREET_RE)
  const out: string[] = []
  if (street) {
    const streetLine = `${street[1]!.replace(BG_QUOTE_CHARS, '').trim()} ${street[2]}`
    out.push(city ? `${streetLine}, ${city}` : streetLine)
  }
  if (city) out.push(city)
  return out.length > 0 ? [...new Set(out)] : [address]
}

/**
 * Normalises an address into a Nominatim-friendly query, optionally falling
 * back to PLZ+city if the full address fails to resolve.
 */
function buildQueries(address: string, country: string): string[] {
  const cleaned = address.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  // Lithuanian and Estonian addresses need structural rewriting, not just
  // suffix handling; Latvian addresses mostly need boilerplate/noise stripped.
  if (country === 'lt') return normalizeLtAddress(cleaned)
  if (country === 'ee') return normalizeEeAddress(cleaned)
  if (country === 'lv') return normalizeLvAddress(cleaned)
  if (country === 'se') return normalizeSeAddress(cleaned)
  if (country === 'bg') return normalizeBgAddress(cleaned)
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
