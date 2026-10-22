import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEASURE,
  formatMeasuredKm,
  measureDistanceKm,
  measureHintKey,
  nextMeasureState,
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

describe('nextMeasureState', () => {
  it('sets A, then B, then restarts at the next click', () => {
    const p1: LngLat = [1, 1]
    const p2: LngLat = [2, 2]
    const p3: LngLat = [3, 3]

    const withA = nextMeasureState(EMPTY_MEASURE, p1)
    expect(withA).toEqual({ a: p1, b: null })

    const done = nextMeasureState(withA, p2)
    expect(done).toEqual({ a: p1, b: p2 })

    expect(nextMeasureState(done, p3)).toEqual({ a: p3, b: null })
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

  it('walks the user through start, end and restart', () => {
    expect(measureHintKey(true, EMPTY_MEASURE)).toBe('map.measureHintStart')
    expect(measureHintKey(true, { a: [1, 1], b: null })).toBe('map.measureHintEnd')
    expect(measureHintKey(true, { a: [1, 1], b: [2, 2] })).toBe('map.measureHintRestart')
  })
})
