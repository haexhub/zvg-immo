import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'

type OsmStatusBucket = 'done' | 'open' | 'error'

interface OsmStatusItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  lastErrorMessage: string | null
}

interface OsmStatusList {
  items: OsmStatusItem[]
  total: number
}

const BUCKETS: OsmStatusBucket[] = ['done', 'open', 'error']
const SORT_FIELDS = ['platform', 'title', 'region', 'error'] as const
type OsmStatusSort = typeof SORT_FIELDS[number]
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200
// `location_enrichment` is left-joined; coalesce keeps auctions without any
// enrichment row in the open/error buckets instead of letting SQL's NULL
// three-valued logic filter them out.
const OSM_CONTEXT_SQL = "coalesce(le.enrichment #>> '{locationContext,source,id}', '') = 'openstreetmap-overpass'"

export default defineEventHandler(async (event): Promise<OsmStatusList> => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  await ensureEnabledCountriesLoaded()
  if (!listRegisteredCountries().some((candidate) => candidate.code === country)) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  const query = getQuery(event)
  const bucket = String(query.bucket ?? '') as OsmStatusBucket
  if (!BUCKETS.includes(bucket)) {
    throw createError({ statusCode: 400, statusMessage: 'bucket muss done, error oder open sein.' })
  }
  const requestedLimit = Number(query.limit ?? DEFAULT_LIMIT)
  const requestedOffset = Number(query.offset ?? 0)
  if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset)) {
    throw createError({ statusCode: 400, statusMessage: 'limit und offset müssen ganze Zahlen sein.' })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
  const offset = Math.max(0, requestedOffset)
  const search = String(query.search ?? '').trim()
  const sort = String(query.sort ?? '') as OsmStatusSort | ''
  const direction = String(query.direction ?? 'asc')
  if (sort && !SORT_FIELDS.includes(sort as OsmStatusSort)) {
    throw createError({ statusCode: 400, statusMessage: 'sort ist ungültig.' })
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw createError({ statusCode: 400, statusMessage: 'direction muss asc oder desc sein.' })
  }

  const db = getPool()
  if (!db) return { items: [], total: 0 }
  const rawData = await db.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM osm_local_elements WHERE country = $1) AS exists',
    [country],
  )
  const sourceAvailable = rawData.rows[0]?.exists ?? false
  const statusCondition = bucket === 'done'
    ? OSM_CONTEXT_SQL
    : bucket === 'open' && sourceAvailable
      ? `NOT (${OSM_CONTEXT_SQL})`
      : bucket === 'error' && !sourceAvailable
        ? `NOT (${OSM_CONTEXT_SQL})`
        : 'FALSE'
  const searchCondition = search
    ? `AND concat_ws(' ', a.platform, a.external_id, a.title, a.region, a.case_number) ILIKE $2`
    : ''
  const filterParams: unknown[] = search ? [country, `%${search}%`] : [country]
  const sortColumn: Record<OsmStatusSort, string> = {
    platform: 'a.platform',
    title: "coalesce(a.title, '')",
    region: 'a.region',
    error: "coalesce(le.enrichment #>> '{locationContext,source,id}', '')",
  }
  const orderBy = `${sortColumn[(sort || 'platform') as OsmStatusSort]} ${direction.toUpperCase()}, a.external_id ASC`
  const baseSql = `
    FROM auctions a
    LEFT JOIN location_enrichment le ON le.platform = a.platform AND le.external_id = a.external_id
    WHERE a.country = $1
      AND a.lat IS NOT NULL AND a.lng IS NOT NULL
      AND ${statusCondition}
      ${searchCondition}
  `
  const pageParams = [...filterParams, limit, offset]
  const [{ rows: countRows }, { rows: itemRows }] = await Promise.all([
    db.query<{ count: string }>(`SELECT count(*) ${baseSql}`, filterParams),
    db.query<Omit<OsmStatusItem, 'lastErrorMessage'>>(
      `SELECT a.platform, a.external_id AS "externalId", a.title, a.region, a.case_number AS "caseNumber"
       ${baseSql}
       ORDER BY ${orderBy}
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    ),
  ])

  return {
    total: Number(countRows[0]?.count ?? 0),
    items: itemRows.map((item) => ({
      ...item,
      lastErrorMessage: bucket === 'error' ? 'Für dieses Land sind keine OSM-Rohdaten geladen.' : null,
    })),
  }
})
