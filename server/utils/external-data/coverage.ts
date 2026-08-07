import type { Pool } from 'pg'

// Which of configurableExternalDataSources()'s sources have a real presence
// check below. The other EXTERNAL_DATA_SOURCES entries are discovery/
// documentation only (sources.ts) or lack an adapter, so "coverage" isn't a
// meaningful concept for them.
export const COVERAGE_SOURCE_IDS = [
  'cams-air-quality',
  'open-meteo-climate-normals',
  'eea-environmental-noise-directive',
  'eu-flood-risk-areas',
  'copernicus-effis',
  'fr-dvf-geolocated',
] as const

export type CoverageSourceId = typeof COVERAGE_SOURCE_IDS[number]

export interface ExternalDataCoverageCountryRow {
  country: string
  total: number
  covered: number
}

export interface ExternalDataSourceCoverage {
  id: CoverageSourceId
  /** Sum of `byCountry[].total` — geocoded auctions across every country with at least one. */
  total: number
  covered: number
  byCountry: ExternalDataCoverageCountryRow[]
}

// One row per country, geocoded_total plus one covered-count column per
// source in COVERAGE_SOURCE_IDS (column name = source id with '-' -> '_').
// A single query grouped by country avoids six-way N+1 scans over
// location_enrichment.
const COVERAGE_QUERY = `
  SELECT
    a.country,
    count(*) FILTER (WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL) AS geocoded_total,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND le.enrichment->'locationContext'->'environment'->'airQuality' IS NOT NULL
    ) AS cams_air_quality,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND le.enrichment->'locationContext'->'environment'->'climateNormals' IS NOT NULL
    ) AS open_meteo_climate_normals,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND jsonb_array_length(coalesce(le.enrichment->'locationContext'->'environment'->'reportedNoise', '[]'::jsonb)) > 0
    ) AS eea_environmental_noise_directive,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(le.enrichment->'hazards', '[]'::jsonb)) h
          WHERE h->>'hazard' = 'flood'
        )
    ) AS eu_flood_risk_areas,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(le.enrichment->'hazards', '[]'::jsonb)) h
          WHERE h->>'hazard' = 'wildfire'
        )
    ) AS copernicus_effis,
    count(*) FILTER (
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(le.enrichment->'marketComparison'->'sources', '[]'::jsonb)) s
          WHERE s->>'id' = 'fr-dvf-geolocated'
        )
    ) AS fr_dvf_geolocated
  FROM auctions a
  LEFT JOIN location_enrichment le ON le.platform = a.platform AND le.external_id = a.external_id
  GROUP BY a.country
`

const COVERAGE_COLUMN_BY_SOURCE_ID: Record<CoverageSourceId, string> = {
  'cams-air-quality': 'cams_air_quality',
  'open-meteo-climate-normals': 'open_meteo_climate_normals',
  'eea-environmental-noise-directive': 'eea_environmental_noise_directive',
  'eu-flood-risk-areas': 'eu_flood_risk_areas',
  'copernicus-effis': 'copernicus_effis',
  'fr-dvf-geolocated': 'fr_dvf_geolocated',
}

type CoverageRow = { country: string; geocoded_total: string } & Record<string, string>

export async function computeExternalDataCoverage(db: Pool): Promise<ExternalDataSourceCoverage[]> {
  const { rows } = await db.query<CoverageRow>(COVERAGE_QUERY)

  const bySource = new Map<CoverageSourceId, ExternalDataSourceCoverage>(
    COVERAGE_SOURCE_IDS.map((id) => [id, { id, total: 0, covered: 0, byCountry: [] }]),
  )

  for (const row of rows) {
    const total = Number(row.geocoded_total)
    // Nothing to show for a country with no geocoded auctions at all.
    if (total === 0) continue
    for (const id of COVERAGE_SOURCE_IDS) {
      const covered = Number(row[COVERAGE_COLUMN_BY_SOURCE_ID[id]])
      const entry = bySource.get(id)!
      entry.total += total
      entry.covered += covered
      entry.byCountry.push({ country: row.country, total, covered })
    }
  }

  for (const entry of bySource.values()) {
    entry.byCountry.sort((a, b) => b.total - a.total)
  }

  return COVERAGE_SOURCE_IDS.map((id) => bySource.get(id)!)
}
