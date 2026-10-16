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
// sind Produktentscheidungen, keine technischen"). Calibrated 2026-08-15
// against real prod data (read-only, 40-80 random geocoded auctions plus
// full-table percentiles where the column already existed) — see comments on
// each constant. Ski is the doc's own worked example and held up against the
// real distribution; water/density/attraction needed real numbers because a
// blind first guess was off by roughly one to two orders of magnitude (see
// build-geo-features.ts's attraction-kind comment for the worst case).

export type CriterionBand = 'sehr_gut' | 'gut' | 'maessig' | 'gering'
export type ProfileLabel = CriterionBand | 'keine_angaben'

export interface LeisureTourismCriterion {
  band: CriterionBand
  /** Raw measured fact for display: km for distances, count for density. */
  value: number | null
}

export interface LeisureTourismCriteria {
  ski: LeisureTourismCriterion
  wasser: LeisureTourismCriterion & { source: 'sea' | 'swimming' | null }
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
  distSwimmingM: number | null
  distHikingM: number | null
  tourismDensityCount: number | null
  attractionDensityCount: number | null
}

// Doc's own worked example (step 3): "Skigebiet: < 15 km sehr gut, < 40 km
// gut, < 80 km mäßig". Held up against real data: 3173 geocoded auctions all
// had a ski_area within the 200km cutoff (p10/p50/p90 = 2.2/9.7/23.4 km) —
// the doc's own bands split that spread sensibly, left as-is.
const SKI_BANDS_KM = { sehrGut: 15, gut: 40, maessig: 80 }
// Deliberately built from distSwimmingM (geo_features kind `swimming`:
// leisure=swimming_area/natural=beach/amenity=public_bath|spa), not the
// generic `lake` kind used by the nearLake search filter — verified live
// that "nearest of any natural=water polygon" (which includes garden ponds)
// has a median distance of just 481m across 3173 auctions, making every
// single one "sehr gut" and the gut/mäßig bands dead code. `swimming` gives
// an actually-discriminating spread (60-sample: p10/p50/p90 = 630/1751/5063m).
const WASSER_BANDS_KM = { sehrGut: 1, gut: 2.5, maessig: 5 }
// Doc's example: "Wanderwegnetz angrenzend" for the sehr-gut case. Held up
// against real data: only 16/80 sampled auctions had any hiking_route
// relation within the 20km cutoff at all (route relations cluster on
// waymarked long-distance networks, not every forest path) — but when one
// exists it is almost always very close (median 165m, max 2074m in that
// same 16), so these bands still split the "has one" case sensibly.
const WANDERN_BANDS_KM = { sehrGut: 2, gut: 8, maessig: 20 }
// tourism_density_count, 10km radius (build-auction-geo-metrics.ts).
// Recalibrated against real data: among 3165 auctions with any count at all,
// p10/p50/p75/p90 = 27/86/140/221, max 715 — the original 20/8/2 guess would
// have put almost every auction with any tourism activity at "sehr gut".
const TOURISMUS_DICHTE_BANDS = { sehrGut: 150, gut: 60, maessig: 20 }
// attraction_density_count, 30km radius, build-geo-features.ts's narrowed
// `attraction` kind (historic=memorial/archaeological_site excluded — see
// that file's comment on why the raw kind was unusable). Recalibrated
// against the narrowed real distribution: p10/p50/p90 = 39/105/252 across 40
// sampled auctions, none at zero.
const SEHENSWUERDIGKEITEN_BANDS = { sehrGut: 200, gut: 100, maessig: 30 }

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
  // Sea and swimming-spot are two different auction_geo_metrics columns with
  // different cutoffs (200km / 20km) — the better (nearer) of the two present
  // values wins, keeping the source so the UI can say "Meer" or "Badestelle"
  // rather than a generic "Wasser".
  let wasserMeters: number | null = null
  let wasserSource: 'sea' | 'swimming' | null = null
  if (metrics.distSeaM != null) { wasserMeters = metrics.distSeaM; wasserSource = 'sea' }
  if (metrics.distSwimmingM != null && (wasserMeters == null || metrics.distSwimmingM < wasserMeters)) {
    wasserMeters = metrics.distSwimmingM
    wasserSource = 'swimming'
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
