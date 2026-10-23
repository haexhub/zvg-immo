import { getDistance } from 'ol/sphere'

/** [lng, lat] in WGS84 — the order OpenLayers' toLonLat/getDistance use. */
export type LngLat = [number, number]

/** One finished A–B measurement. `id` is its stable identity for removal and
 *  is never reused within a MeasureState. */
export interface Measurement {
  id: number
  a: LngLat
  b: LngLat
}

/** `pending` is point A of the measurement being drawn. Immutable: every
 *  function below returns a new state. */
export interface MeasureState {
  measurements: Measurement[]
  pending: LngLat | null
  nextId: number
}

export const EMPTY_MEASURE: MeasureState = { measurements: [], pending: null, nextId: 1 }

/** One map click while measuring: first sets A, second completes the
 *  measurement. Finished measurements stay; the next click starts a new one. */
export function addMeasurePoint(state: MeasureState, point: LngLat): MeasureState {
  if (!state.pending) return { ...state, pending: point }
  return {
    measurements: [...state.measurements, { id: state.nextId, a: state.pending, b: point }],
    pending: null,
    nextId: state.nextId + 1,
  }
}

/** Removes exactly the measurement with this id; an unknown id returns the
 *  same state object. The pending point A is never touched. */
export function removeMeasurement(state: MeasureState, id: number): MeasureState {
  if (!state.measurements.some((m) => m.id === id)) return state
  return { ...state, measurements: state.measurements.filter((m) => m.id !== id) }
}

/** Leaving measuring mode keeps finished measurements but drops a lone A. */
export function discardPending(state: MeasureState): MeasureState {
  return state.pending ? { ...state, pending: null } : state
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
  return state.pending ? 'map.measureHintEnd' : 'map.measureHintStart'
}
