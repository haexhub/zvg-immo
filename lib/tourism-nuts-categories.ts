// Search-map "Besucherintensität"-Ebene — the sequential-magnitude
// counterpart to lib/tourism-grid-categories.ts's categorical POI-density
// grid. Bin index/breaks are computed server-side at import time (see
// server/utils/external-data/eurostat-tourism-nuts.ts), so this file only
// needs to know how to color a bin, not recompute one.

export const TOURISM_NUTS_NUM_BINS = 6

// dataviz skill's default sequential hue (blue, steps 100→700), light→dark —
// 6 steps chosen from that ramp (150/250/350/450/550/650), skipping the very
// lightest (near-white, illegible against a light basemap) and very darkest
// (too close to map ink/labels). This is the first use of the skill's actual
// stepped hex ramp in this codebase; the POI-density grid instead modulates
// one fixed categorical hue's alpha (see tourism-grid-categories.ts's
// comment) — that technique fits a *categorical* magnitude overlay, but this
// layer is a genuine one-dimensional magnitude, so the light→dark hue
// progression carries more signal than alpha alone would.
export const TOURISM_NUTS_BIN_COLORS: readonly string[] = [
  '#b7d3f6',
  '#86b6ef',
  '#5598e7',
  '#2a78d6',
  '#1c5cab',
  '#104281',
]

// A region with no Eurostat figure at all must never look like "very low
// intensity" — a distinct neutral gray, not the lightest blue step above.
export const TOURISM_NUTS_NO_DATA_COLOR = '#c3c2b7'

export function tourismNutsBinColor(bin: number | null): string {
  if (bin == null) return TOURISM_NUTS_NO_DATA_COLOR
  const index = Math.min(Math.max(bin, 0), TOURISM_NUTS_BIN_COLORS.length - 1)
  return TOURISM_NUTS_BIN_COLORS[index]!
}
