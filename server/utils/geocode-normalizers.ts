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
const LT_ADMIN = new Set(['sav.', 'r.', 'raj.', 'm.', 'k.', 'mstl.', 'sen.', 'vs.', 'apskr.'])
const LT_STREET = new Set(['g.', 'pr.', 'al.', 'pl.', 'skg.', 'kel.'])
const LT_LOCALITY = new Set(['m.', 'k.', 'mstl.', 'vs.'])

export function normalizeLtAddress(address: string): string[] {
  const tokens = address.split(' ').filter(Boolean)
  const streetIdx = tokens.findIndex((t) => LT_STREET.has(t))
  const out: string[] = []

  if (streetIdx > 0 && streetIdx < tokens.length - 1) {
    const houseNr = tokens[streetIdx + 1]!.split('-')[0]!
    let i = streetIdx - 1
    const parts: string[] = []
    while (i >= 0 && !LT_ADMIN.has(tokens[i]!)) parts.unshift(tokens[i--]!)
    const street = `${parts.join(' ')} ${tokens[streetIdx]} ${houseNr}`.trim()
    const city = i >= 1 ? tokens[i - 1] : ''
    if (city) {
      out.push(`${street}, ${city}`)
      out.push(city)
    } else {
      out.push(street)
    }
  } else {
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
const EE_STREET_TOKENS = new Set(['tn', 'mnt', 'pst', 'tee', 'tänav', 'puiestee', 'maantee', 'põik'])
const EE_STREET_SUFFIXES = ['maantee', 'puiestee', 'tänav']
const EE_LOCALITY_SUFFIXES = ['linnaosa', 'alevik', 'alev', 'küla', 'linn']
const EE_ADMIN_SUFFIXES = ['vald', 'maakond']

function matchEeStreetToken(token: string): { exact: boolean; prefix: string } | null {
  if (EE_STREET_TOKENS.has(token)) return { exact: true, prefix: '' }
  const suffix = EE_STREET_SUFFIXES.find((s) => token.length > s.length && token.endsWith(s))
  return suffix ? { exact: false, prefix: token.slice(0, token.length - suffix.length) } : null
}

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

const LV_SUFFIX_PATTERNS: RegExp[] = [
  /,?\s*(?:nomas tiesīb[au]\s+)?(?:trešo\s+)?elektronisk[aāuo]\s+izsol[eiu]\.?$/i,
  /\s+izsole\.?$/i,
  /\s+atsavināšana\.?$/i,
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
  return out.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

const LV_QUOTE_CHARS = /["'`‘’“”„]/g
function stripLvQuotes(address: string): string {
  return address.replace(/,,(\S)/g, '$1').replace(LV_QUOTE_CHARS, '')
}

function stripLvUnitSuffix(core: string): string {
  return core
    .replace(/\s*[-–]?\s*k-\d+(?:[\s-–]*\d+)?/gi, '')
    .replace(/(\d+[A-Za-zĀ-Žā-ž]?)\s*[-–]\s*\d+[A-Za-zĀ-Žā-ž]?\s*$/, '$1')
    .trim()
}

function expandLvAdminAbbrev(s: string): string {
  return s.replace(/\bpag\.(?=\s|,|$)/gi, 'pagasts').replace(/\bnov\.(?=\s|,|$)/gi, 'novads')
}

export function normalizeLvAddress(address: string): string[] {
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

  const parishMatch = cleaned.match(/(\S+)\s+(pagast[sā])/i)
  if (parishMatch) out.push(`${parishMatch[1]} ${parishMatch[2]}`)
  const districtMatch = cleaned.match(/(\S+)\s+(novad[sā])/i)
  if (districtMatch) out.push(`${districtMatch[1]} ${districtMatch[2]}`)

  return out.length > 0 ? [...new Set(out)] : [address]
}

// --- Sweden (kronofogden.se) -------------------------------------------------
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
const BG_SETTLEMENT_RE = /(?:гр\.|град|с\.|село)\s*([^,]+)/
const BG_STREET_RE = /(?:ул|бул|кв)\.\s*"?([^"\n,№]+?)"?\s*№\s*(\d+[a-zA-Zа-яА-Я]?)/
const BG_MUNICIPALITY_RE = /община\s*([^,]+)/
const BG_PROVINCE_RE = /област\s*([^,]+)/
const BG_LOCALITY_RE = /местност\s*([^,]+)/
const BG_QUOTE_CHARS = /["'„“”‘’]/g

export function normalizeBgAddress(address: string): string[] {
  const settlement = address.match(BG_SETTLEMENT_RE)?.[1]?.trim()
  const municipality = address.match(BG_MUNICIPALITY_RE)?.[1]?.trim()
  const province = address.match(BG_PROVINCE_RE)?.[1]?.trim()
  const locality = address.match(BG_LOCALITY_RE)?.[1]?.replace(BG_QUOTE_CHARS, '').trim()
  const street = address.match(BG_STREET_RE)
  const out: string[] = []
  if (street) {
    const streetLine = `${street[1]!.replace(BG_QUOTE_CHARS, '').trim()} ${street[2]}`
    out.push(settlement ? `${streetLine}, ${settlement}` : streetLine)
  }
  if (locality && settlement) out.push(`${locality}, ${settlement}`)
  if (locality && municipality) out.push(`${locality}, ${municipality}`)
  if (settlement && municipality) out.push(`${settlement}, ${municipality}`)
  if (settlement && province) out.push(`${settlement}, ${province}`)
  if (settlement) out.push(settlement)
  if (municipality) out.push(municipality)
  if (province) out.push(province)
  return out.length > 0 ? [...new Set(out)] : [address]
}

/**
 * Normalises an address into a Nominatim-friendly query, optionally falling
 * back to PLZ+city if the full address fails to resolve.
 */
export function buildGeocodeQueries(address: string, country: string): string[] {
  const cleaned = address.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  if (country === 'lt') return normalizeLtAddress(cleaned)
  if (country === 'ee') return normalizeEeAddress(cleaned)
  if (country === 'lv') return normalizeLvAddress(cleaned)
  if (country === 'se') return normalizeSeAddress(cleaned)
  if (country === 'bg') return normalizeBgAddress(cleaned)
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
