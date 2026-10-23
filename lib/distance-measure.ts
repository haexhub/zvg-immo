import { getDistance } from 'ol/sphere'

/** [lng, lat] in WGS84 — the order OpenLayers' toLonLat/getDistance use. */
export type LngLat = [number, number]

/** The detail map's two-point measurement: `b` is only ever set once `a` is. */
export interface MeasureState {
  a: LngLat | null
  b: LngLat | null
}

export const EMPTY_MEASURE: MeasureState = { a: null, b: null }

/** One map click while measuring: first sets A, second sets B, and a click on
 *  a finished A–B measurement discards it and starts a new one at that point. */
export function nextMeasureState(state: MeasureState, point: LngLat): MeasureState {
  if (state.a && !state.b) return { a: state.a, b: point }
  return { a: point, b: null }
}

/** Great-circle distance on the WGS84 mean radius — the map's Web Mercator
 *  projection would overstate it by 1/cos(lat), ~60 % at German latitudes. */
export function measureDistanceKm(a: LngLat, b: LngLat): number {
  return getDistance(a, b) / 1000
}

/** Always km (the spec rules out switching to metres): two decimals below
 *  10 km keep ~10 m resolution, coarser beyond where that precision is noise. */
export function formatMeasuredKm(km: number, locale: string): string {
  const maximumFractionDigits = km < 10 ? 2 : km < 100 ? 1 : 0
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(km)
}

export function measureHintKey(active: boolean, state: MeasureState): string | null {
  if (!active) return null
  if (!state.a) return 'map.measureHintStart'
  if (!state.b) return 'map.measureHintEnd'
  return 'map.measureHintRestart'
}
