// Search-map "Tourismus-Layer" (see docs/plans — grid built by
// server/tasks/build-tourism-grid.ts, served by server/api/tourism-grid.get.ts,
// rendered by composables/useTourismGridLayer.ts). One definition, shared by
// writer, reader and frontend, so the category list and the grid's cell size
// can never drift between them.

export type TourismCategory = 'ski' | 'hiking' | 'swimming' | 'attraction' | 'lodging'

export interface TourismGridCategoryDef {
  category: TourismCategory
  /** geo_features.kind values aggregated into this category. */
  kinds: string[]
  // dataviz skill's categorical slots 1-5 (blue/orange/aqua/yellow/magenta),
  // fixed order from the validated default palette — do not reorder or
  // cherry-pick by "thematic fit", the order itself is the colorblind-safety
  // mechanism. Validated (adjacent-pairs, this exact 5-slot subset) at
  // ΔE 9.1 CVD / 19.6 normal-vision, both above target. All-pairs (i.e. two of
  // these rendered on the map at once) FAILS the normal-vision floor
  // (worst pair ΔE 12.9, magenta vs orange) — see Map.client.vue, which
  // deliberately renders only one category's grid at a time for this reason.
  color: string
}

export const TOURISM_GRID_CATEGORIES: TourismGridCategoryDef[] = [
  { category: 'ski', kinds: ['ski_area'], color: '#2a78d6' },
  { category: 'hiking', kinds: ['hiking_route', 'mtb_route'], color: '#eb6834' },
  { category: 'swimming', kinds: ['swimming'], color: '#1baf7a' },
  { category: 'attraction', kinds: ['attraction'], color: '#eda100' },
  { category: 'lodging', kinds: ['tourism_supply'], color: '#e87ba4' },
]

export function tourismGridCategory(category: string): TourismGridCategoryDef | undefined {
  return TOURISM_GRID_CATEGORIES.find((c) => c.category === category)
}

export function isTourismCategory(value: string): value is TourismCategory {
  return TOURISM_GRID_CATEGORIES.some((c) => c.category === value)
}

// Fixed square grid in EPSG:3035 (same projection as geo_features) — coarse
// enough to render as a legible choropleth at country zoom without producing
// an unmanageable number of cells (Europe's ~10M km^2 divides into roughly
// 100k cells at this size, the same order of magnitude as climate_cells'
// ~150k 0.1° cells). Shared by the build job (which floors each feature's
// centroid into a cell) and the API endpoint (which reconstructs each cell's
// polygon bounds from cellX/cellY * CELL_SIZE_M) — they must never disagree.
export const TOURISM_GRID_CELL_SIZE_M = 10_000

// Alpha ramp over a single categorical hex, not a per-hue lightness ramp: the
// dataviz skill's reference palette only fully specifies stepped hex values
// for its default sequential hue (blue), and modulating a documented
// categorical hex's opacity is the standard technique for a magnitude overlay
// on a map background that isn't a flat chart surface. Count thresholds are
// placeholders pending the real-data calibration pass described in the
// design plan (WP-8 used the same "don't guess bands" methodology for
// leisure-tourism-profile.ts).
export const TOURISM_INTENSITY_THRESHOLDS = [1, 3, 8, 20] as const
export const TOURISM_INTENSITY_ALPHAS = [0.12, 0.28, 0.45, 0.62, 0.8] as const

export function tourismIntensityAlpha(count: number): number {
  let bucket = 0
  for (const threshold of TOURISM_INTENSITY_THRESHOLDS) {
    if (count < threshold) break
    bucket++
  }
  // bucket is always in range (0..thresholds.length, matching the alphas
  // array length) — Math.min/! only satisfy noUncheckedIndexedAccess, which
  // can't see that bound itself.
  return TOURISM_INTENSITY_ALPHAS[Math.min(bucket, TOURISM_INTENSITY_ALPHAS.length - 1)]!
}
