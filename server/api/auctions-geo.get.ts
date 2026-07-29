import { geocodeAddress, geocodeStatus } from '~/server/utils/geocode'
import { getPool } from '~/server/utils/db'

export interface GeoAuction {
  platform: string
  externalId: string
  country: string
  region: string
  lat: number
  lng: number
}

export interface GeoCrawlResult {
  auctions: GeoAuction[]
  total: number
  geocodedCount: number
  unresolvableCount: number
  fetchedAt: string
}

interface MarkerRow {
  platform: string
  external_id: string
  country: string
  region: string
  address: string | null
  lat: string | number | null
  lng: string | number | null
}

function commaList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(parsed) ? parsed : null
}

export default defineEventHandler(async (event): Promise<GeoCrawlResult> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  const query = getQuery(event)
  const values: unknown[] = []
  const where: string[] = []
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  const countries = commaList(query.country).filter((entry) => /^[a-z]{2}$/i.test(entry))
  if (countries.length) where.push(`a.country = ANY(${add(countries)}::text[])`)
  const regions = commaList(query.regionNames)
  if (regions.length) where.push(`(a.country || ':' || a.region) = ANY(${add(regions)}::text[])`)
  const search = String(query.q ?? '').trim()
  if (search) {
    where.push(`concat_ws(' ', a.case_number, a.authority, a.title, a.address, a.description) ILIKE ${add(`%${search}%`)}`)
  }
  const authority = String(query.authority ?? '')
  if (authority && authority !== 'all') where.push(`a.authority = ${add(authority)}`)
  const category = String(query.category ?? '')
  if (category && category !== 'all') where.push(`a.property_type = ${add(category)}`)
  const condition = String(query.condition ?? '')
  if (condition && condition !== 'all') where.push(`a.condition #>> '{}' = ${add(condition)}`)
  const features = commaList(query.features)
  if (features.length) where.push(`a.features && ${add(features)}::text[]`)
  if (String(query.photos ?? '') === '1') where.push('a.photo_count > 0')
  if (String(query.cancelled ?? '') !== '1') where.push('a.cancelled = false')
  if (String(query.llmOnly ?? '') === '1') {
    where.push(`(
      a.extraction_source = 'llm'
      OR ec.extraction ? 'llmAnalyzedAt'
      OR ec.extraction ? 'condition'
      OR ec.extraction ? 'features'
      OR ec.extraction ? 'insights'
    )`)
  }
  const ranges: Array<[unknown, string, '>=' | '<=']> = [
    [query.priceMin, 'a.market_value_eur', '>='],
    [query.priceMax, 'a.market_value_eur', '<='],
    [query.landMin, 'a.land_area_sqm', '>='],
    [query.landMax, 'a.land_area_sqm', '<='],
    [query.livMin, 'a.living_area_sqm', '>='],
    [query.livMax, 'a.living_area_sqm', '<='],
    [query.yearBuiltMin, 'a.year_built', '>='],
    [query.yearBuiltMax, 'a.year_built', '<='],
    [query.renovationYearMin, 'a.last_renovation_year', '>='],
    [query.renovationYearMax, 'a.last_renovation_year', '<='],
  ]
  for (const [raw, column, operator] of ranges) {
    const value = finiteNumber(raw)
    if (value != null) where.push(`${column} ${operator} ${add(value)}`)
  }

  const { rows } = await db.query<MarkerRow>(
    `SELECT a.platform, a.external_id, a.country, a.region, a.address, a.lat, a.lng
     FROM auctions a
     LEFT JOIN extraction_cache ec
       ON ec.platform = a.platform AND ec.external_id = a.external_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.platform, a.external_id`,
    values,
  )

  const fetchMissing = query.fetch === '1'
  const markers: Array<GeoAuction | undefined> = new Array(rows.length)
  let unresolvableCount = 0
  let cursor = 0
  let aborted = false
  event.node.req.on('close', () => {
    aborted = true
  })

  async function worker(): Promise<void> {
    while (cursor < rows.length && !aborted) {
      const index = cursor++
      const row = rows[index]!
      let lat = finiteNumber(row.lat)
      let lng = finiteNumber(row.lng)
      if ((lat == null || lng == null) && row.address) {
        const point = await geocodeAddress(row.address, row.country, { fetchMissing })
        lat = point?.lat ?? null
        lng = point?.lng ?? null
        if (!point && await geocodeStatus(row.address, row.country) === 'unresolvable') {
          unresolvableCount++
        }
      }
      if (lat == null || lng == null) continue
      markers[index] = {
        platform: row.platform,
        externalId: row.external_id,
        country: row.country,
        region: row.region,
        lat,
        lng,
      }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  const auctions = markers.filter((marker): marker is GeoAuction => marker != null)
  setResponseHeader(event, 'cache-control', 'no-store')
  return {
    auctions,
    total: rows.length,
    geocodedCount: auctions.length,
    unresolvableCount,
    fetchedAt: new Date().toISOString(),
  }
})
