// Single-auction variant of coverage.ts's per-country aggregate: same
// per-source presence predicates against location_enrichment, but scoped to
// one identity for the admin technical overview
// (server/utils/auction-technical.ts) instead of grouped across the whole
// country.

import type { Pool } from 'pg'
import { COVERAGE_SOURCE_IDS, type CoverageSourceId } from './coverage'

export interface AuctionExternalDataCoverageEntry {
  id: CoverageSourceId
  covered: boolean
}

export interface AuctionExternalDataCoverage {
  geocoded: boolean
  checkedAt: string | null
  sources: AuctionExternalDataCoverageEntry[]
}

const COVERAGE_QUERY = `
  SELECT
    a.lat IS NOT NULL AND a.lng IS NOT NULL AS geocoded,
    le.checked_at,
    nullif(le.enrichment->'locationContext'->'environment'->'airQuality', 'null'::jsonb) IS NOT NULL AS cams_air_quality,
    le.enrichment->'locationContext'->'environment'->'climateNormals' IS NOT NULL AS open_meteo_climate_normals,
    jsonb_array_length(coalesce(le.enrichment->'locationContext'->'environment'->'reportedNoise', '[]'::jsonb)) > 0 AS eea_environmental_noise_directive,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(nullif(le.enrichment->'hazards', 'null'::jsonb), '[]'::jsonb)) h
      WHERE h->>'hazard' = 'flood'
    ) AS eu_flood_risk_areas,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(nullif(le.enrichment->'hazards', 'null'::jsonb), '[]'::jsonb)) h
      WHERE h->>'hazard' = 'wildfire'
    ) AS copernicus_effis,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(le.enrichment->'marketComparison'->'sources', '[]'::jsonb)) s
      WHERE s->>'id' = 'fr-dvf-geolocated'
    ) AS fr_dvf_geolocated
  FROM auctions a
  LEFT JOIN location_enrichment le ON le.platform = a.platform AND le.external_id = a.external_id
  WHERE a.platform = $1 AND a.external_id = $2
`

const COVERAGE_COLUMN_BY_SOURCE_ID: Record<CoverageSourceId, string> = {
  'cams-air-quality': 'cams_air_quality',
  'open-meteo-climate-normals': 'open_meteo_climate_normals',
  'eea-environmental-noise-directive': 'eea_environmental_noise_directive',
  'eu-flood-risk-areas': 'eu_flood_risk_areas',
  'copernicus-effis': 'copernicus_effis',
  'fr-dvf-geolocated': 'fr_dvf_geolocated',
}

type CoverageRow = { geocoded: boolean; checked_at: string | Date | null } & Record<string, boolean>

export async function computeAuctionExternalDataCoverage(
  db: Pool,
  platform: string,
  externalId: string,
): Promise<AuctionExternalDataCoverage | null> {
  const { rows } = await db.query<CoverageRow>(COVERAGE_QUERY, [platform, externalId])
  const row = rows[0]
  if (!row) return null
  return {
    geocoded: row.geocoded,
    checkedAt: row.checked_at == null ? null : (row.checked_at instanceof Date ? row.checked_at.toISOString() : row.checked_at),
    sources: COVERAGE_SOURCE_IDS.map((id) => ({ id, covered: row[COVERAGE_COLUMN_BY_SOURCE_ID[id]] === true })),
  }
}
