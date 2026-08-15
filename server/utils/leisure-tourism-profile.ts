// GIS WP-8 (docs/plans/2026-08-04-gis-wp8-lagebeschreibung.md): turns the
// precomputed auction_geo_metrics columns (WP-5/WP-6) into a "Freizeit &
// Tourismus"-Einschätzung in zwei Lesarten. Pure aggregation — no DB access,
// no new data — so it is unit-testable against constructed inputs.
//
// Two pitfalls the doc calls out explicitly, both handled here:
// - A single missing criterion is never scored as 0/"best". A distance
//   column is NULL only because the precompute found nothing of that kind
//   within its cutoff (see geo-metric-categories.ts's own comment) — that is
//   a real, presentable fact ("kein Skigebiet in 200 km"), so it maps to the
//   worst band, never silently to "0 Meter entfernt".
// - A whole missing `auction_geo_metrics` row (not yet precomputed) is
//   different from a missing single criterion — it means nothing at all is
//   known yet, so the whole profile reports `keine_angaben` instead of a
//   confident-looking judgement built from nothing.
//
// Thresholds are named constants below, per the doc's step 3 ("Schwellenwerte
// sind Produktentscheidungen, keine technischen") — the ski band is the
// doc's own worked example; water/hiking/density bands are a first proposal,
// not yet calibrated against real auction data (doc's Verifikation step 3).

export type CriterionBand = 'sehr_gut' | 'gut' | 'maessig' | 'gering'
export type ProfileLabel = CriterionBand | 'keine_angaben'

export interface LeisureTourismCriterion {
  band: CriterionBand
  /** Raw measured fact for display: km for distances, count for density. */
  value: number | null
}

export interface LeisureTourismCriteria {
  ski: LeisureTourismCriterion
  wasser: LeisureTourismCriterion & { source: 'sea' | 'lake' | null }
  wandern: LeisureTourismCriterion
  tourismusDichte: LeisureTourismCriterion
  sehenswuerdigkeiten: LeisureTourismCriterion
}

export interface LeisureTourismAssessment {
  label: ProfileLabel
  criteria: LeisureTourismCriteria | null
}

export interface LeisureTourismProfiles {
  eigennutzung: LeisureTourismAssessment
  wirtschaftlich: LeisureTourismAssessment
}

export interface LeisureTourismMetricsInput {
  distSkiM: number | null
  distSeaM: number | null
  distLakeM: number | null
  distHikingM: number | null
  tourismDensityCount: number | null
  attractionDensityCount: number | null
}

// Doc's own worked example (step 3): "Skigebiet: < 15 km sehr gut, < 40 km
// gut, < 80 km mäßig".
const SKI_BANDS_KM = { sehrGut: 15, gut: 40, maessig: 80 }
// Doc's example puts a 1.8km lake at "sehr gut" — walking/short-bike
// distance to swim vs. a short drive vs. still-reachable day trip.
const WASSER_BANDS_KM = { sehrGut: 3, gut: 15, maessig: 40 }
// Doc's example: "Wanderwegnetz angrenzend" for the sehr-gut case.
const WANDERN_BANDS_KM = { sehrGut: 2, gut: 8, maessig: 20 }
// tourism_density_count, 10km radius (build-auction-geo-metrics.ts).
const TOURISMUS_DICHTE_BANDS = { sehrGut: 20, gut: 8, maessig: 2 }
// attraction_density_count, 30km radius — doc's example: "12 Sehenswürdig-
// keiten im Umkreis 30 km" landed in a "sehr gut" overall verdict.
const SEHENSWUERDIGKEITEN_BANDS = { sehrGut: 12, gut: 5, maessig: 1 }

function distanceBand(meters: number | null, bandsKm: { sehrGut: number, gut: number, maessig: number }): CriterionBand {
  if (meters == null) return 'gering'
  const km = meters / 1000
  if (km < bandsKm.sehrGut) return 'sehr_gut'
  if (km < bandsKm.gut) return 'gut'
  if (km < bandsKm.maessig) return 'maessig'
  return 'gering'
}

function densityBand(count: number | null, bands: { sehrGut: number, gut: number, maessig: number }): CriterionBand {
  if (count == null) return 'gering'
  if (count >= bands.sehrGut) return 'sehr_gut'
  if (count >= bands.gut) return 'gut'
  if (count >= bands.maessig) return 'maessig'
  return 'gering'
}

function buildCriteria(metrics: LeisureTourismMetricsInput): LeisureTourismCriteria {
  // Sea and lake are two different auction_geo_metrics columns with
  // different cutoffs (200km / 50km) — the better (nearer) of the two present
  // values wins, keeping the source so the UI can say "Meer" or "Badesee"
  // rather than a generic "Wasser".
  let wasserMeters: number | null = null
  let wasserSource: 'sea' | 'lake' | null = null
  if (metrics.distSeaM != null) { wasserMeters = metrics.distSeaM; wasserSource = 'sea' }
  if (metrics.distLakeM != null && (wasserMeters == null || metrics.distLakeM < wasserMeters)) {
    wasserMeters = metrics.distLakeM
    wasserSource = 'lake'
  }

  return {
    ski: { band: distanceBand(metrics.distSkiM, SKI_BANDS_KM), value: metrics.distSkiM },
    wasser: { band: distanceBand(wasserMeters, WASSER_BANDS_KM), value: wasserMeters, source: wasserSource },
    wandern: { band: distanceBand(metrics.distHikingM, WANDERN_BANDS_KM), value: metrics.distHikingM },
    tourismusDichte: {
      band: densityBand(metrics.tourismDensityCount, TOURISMUS_DICHTE_BANDS),
      value: metrics.tourismDensityCount,
    },
    sehenswuerdigkeiten: {
      band: densityBand(metrics.attractionDensityCount, SEHENSWUERDIGKEITEN_BANDS),
      value: metrics.attractionDensityCount,
    },
  }
}

const BAND_POINTS: Record<CriterionBand, number> = { sehr_gut: 3, gut: 2, maessig: 1, gering: 0 }

interface ProfileWeights {
  ski: number
  wasser: number
  wandern: number
  tourismusDichte: number
  sehenswuerdigkeiten: number
}

// Directly from the doc's "Zwei Nutzungsprofile, ein Datensatz" table: for
// Eigennutzung, Ski/Wasser/Wandern weigh "mittel" and Dichte/Sehenswürdig-
// keiten weigh "niedrig"; for wirtschaftliche Nutzung all five weigh "hoch"
// (a flat average) — never a shared single score across both profiles.
const WEIGHTS: Record<'eigennutzung' | 'wirtschaftlich', ProfileWeights> = {
  eigennutzung: { ski: 2, wasser: 2, wandern: 2, tourismusDichte: 1, sehenswuerdigkeiten: 1 },
  wirtschaftlich: { ski: 3, wasser: 3, wandern: 3, tourismusDichte: 3, sehenswuerdigkeiten: 3 },
}

function labelFromScore(criteria: LeisureTourismCriteria, weights: ProfileWeights): CriterionBand {
  const entries: [keyof ProfileWeights, LeisureTourismCriterion][] = [
    ['ski', criteria.ski],
    ['wasser', criteria.wasser],
    ['wandern', criteria.wandern],
    ['tourismusDichte', criteria.tourismusDichte],
    ['sehenswuerdigkeiten', criteria.sehenswuerdigkeiten],
  ]
  let weightedSum = 0
  let weightTotal = 0
  for (const [key, criterion] of entries) {
    const weight = weights[key]
    weightedSum += weight * BAND_POINTS[criterion.band]
    weightTotal += weight
  }
  const average = weightedSum / weightTotal
  if (average >= 2.5) return 'sehr_gut'
  if (average >= 1.5) return 'gut'
  if (average >= 0.5) return 'maessig'
  return 'gering'
}

/**
 * Builds both Nutzungsprofile from one auction_geo_metrics row. `metrics ===
 * null` means the row does not exist yet (auction not geocoded, or not yet
 * precomputed) — both profiles report `keine_angaben` rather than a
 * judgement built from nothing.
 */
export function buildLeisureTourismProfiles(metrics: LeisureTourismMetricsInput | null): LeisureTourismProfiles {
  if (!metrics) {
    return {
      eigennutzung: { label: 'keine_angaben', criteria: null },
      wirtschaftlich: { label: 'keine_angaben', criteria: null },
    }
  }
  const criteria = buildCriteria(metrics)
  return {
    eigennutzung: { label: labelFromScore(criteria, WEIGHTS.eigennutzung), criteria },
    wirtschaftlich: { label: labelFromScore(criteria, WEIGHTS.wirtschaftlich), criteria },
  }
}
