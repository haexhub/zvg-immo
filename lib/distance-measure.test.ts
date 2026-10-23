import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEASURE,
  addMeasurePoint,
  discardPending,
  formatMeasuredKm,
  measureDistanceKm,
  measureHintKey,
  removeButtonOffset,
  removeMeasurement,
  type LngLat,
} from './distance-measure'

const BERLIN: LngLat = [13.405, 52.52]
const MUNICH: LngLat = [11.582, 48.135]

describe('measureDistanceKm', () => {
  it('matches the great-circle distance Berlin–Munich within 0.5 %', () => {
    expect(measureDistanceKm(BERLIN, MUNICH)).toBeGreaterThan(504 * 0.995)
    expect(measureDistanceKm(BERLIN, MUNICH)).toBeLessThan(504 * 1.005)
  })

  it('is zero for identical points', () => {
    expect(measureDistanceKm(BERLIN, BERLIN)).toBe(0)
  })
})

describe('addMeasurePoint', () => {
  const p1: LngLat = [1, 1]
  const p2: LngLat = [2, 2]
  const p3: LngLat = [3, 3]
  const p4: LngLat = [4, 4]

  it('sets A first, then completes the measurement with B', () => {
    const withA = addMeasurePoint(EMPTY_MEASURE, p1)
    expect(withA.pending).toEqual(p1)
    expect(withA.measurements).toEqual([])

    const done = addMeasurePoint(withA, p2)
    expect(done.pending).toBeNull()
    expect(done.measurements).toEqual([{ id: 1, a: p1, b: p2 }])
  })

  it('keeps finished measurements when the next one starts and ends', () => {
    const first = addMeasurePoint(addMeasurePoint(EMPTY_MEASURE, p1), p2)
    const startedSecond = addMeasurePoint(first, p3)
    expect(startedSecond.measurements).toHaveLength(1)
    expect(startedSecond.pending).toEqual(p3)

    const second = addMeasurePoint(startedSecond, p4)
    expect(second.measurements.map((m) => m.id)).toEqual([1, 2])
  })

  it('does not mutate the previous state', () => {
    const before = addMeasurePoint(EMPTY_MEASURE, p1)
    addMeasurePoint(before, p2)
    expect(before.pending).toEqual(p1)
    expect(before.measurements).toEqual([])
    expect(EMPTY_MEASURE.pending).toBeNull()
  })
})

describe('removeMeasurement', () => {
  const state = [[1, 1], [2, 2], [1, 1], [2, 2]].reduce(
    (s, p) => addMeasurePoint(s, p as LngLat),
    EMPTY_MEASURE,
  )

  it('removes only the measurement with that id, even if another has the same distance', () => {
    expect(state.measurements.map((m) => m.id)).toEqual([1, 2])
    const after = removeMeasurement(state, 1)
    expect(after.measurements.map((m) => m.id)).toEqual([2])
  })

  it('leaves the pending point A alone', () => {
    const withPending = addMeasurePoint(state, [9, 9])
    expect(removeMeasurement(withPending, 2).pending).toEqual([9, 9])
  })

  it('returns the same state for an unknown id', () => {
    expect(removeMeasurement(state, 99)).toBe(state)
  })

  it('does not reuse the id of a removed measurement', () => {
    const next = addMeasurePoint(addMeasurePoint(removeMeasurement(state, 2), [5, 5]), [6, 6])
    expect(next.measurements.map((m) => m.id)).toEqual([1, 3])
  })
})

describe('discardPending', () => {
  it('drops a lone A but keeps finished measurements', () => {
    const state = addMeasurePoint(addMeasurePoint(addMeasurePoint(EMPTY_MEASURE, [1, 1]), [2, 2]), [3, 3])
    const after = discardPending(state)
    expect(after.pending).toBeNull()
    expect(after.measurements).toHaveLength(1)
  })

  it('returns the same state when nothing is pending', () => {
    expect(discardPending(EMPTY_MEASURE)).toBe(EMPTY_MEASURE)
  })
})

describe('formatMeasuredKm', () => {
  it('keeps two decimals below 10 km in the UI locale', () => {
    expect(formatMeasuredKm(0.3456, 'de-DE')).toBe('0,35')
  })

  it('drops decimals from 100 km on', () => {
    expect(formatMeasuredKm(123.4, 'en-US')).toBe('123')
  })

  it('formats zero without decimals', () => {
    expect(formatMeasuredKm(0, 'de-DE')).toBe('0')
  })
})

describe('measureHintKey', () => {
  it('has no hint while measuring is off', () => {
    expect(measureHintKey(false, EMPTY_MEASURE)).toBeNull()
  })

  it('asks for the start point, then the end point, and again for a start after a finished measurement', () => {
    expect(measureHintKey(true, EMPTY_MEASURE)).toBe('map.measureHintStart')
    const withA = addMeasurePoint(EMPTY_MEASURE, [1, 1])
    expect(measureHintKey(true, withA)).toBe('map.measureHintEnd')
    expect(measureHintKey(true, addMeasurePoint(withA, [2, 2]))).toBe('map.measureHintStart')
  })
})

describe('removeButtonOffset', () => {
  const size: [number, number] = [800, 400]
  const margin = 16

  function insideViewport([x, y]: [number, number], [dx, dy]: [number, number]): boolean {
    return x + dx - margin >= 0 && x + dx + margin <= size[0] && y + dy - margin >= 0 && y + dy + margin <= size[1]
  }

  it('puts the button below and to the right of the line in the middle of the map', () => {
    expect(removeButtonOffset([400, 200], size)).toEqual([14, 14])
  })

  it('flips horizontally near the right edge and vertically near the bottom edge', () => {
    expect(removeButtonOffset([790, 200], size)).toEqual([-14, 14])
    expect(removeButtonOffset([400, 395], size)).toEqual([14, -14])
    expect(removeButtonOffset([795, 397], size)).toEqual([-14, -14])
  })

  it('keeps the button inside the viewport for anchors along every edge', () => {
    const anchors: [number, number][] = [[400, 200], [790, 200], [400, 5], [795, 3], [20, 395], [790, 395], [3, 3]]
    for (const anchor of anchors) {
      expect(insideViewport(anchor, removeButtonOffset(anchor, size, margin)), `anchor ${anchor}`).toBe(true)
    }
  })
})
