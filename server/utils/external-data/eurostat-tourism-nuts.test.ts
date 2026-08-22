import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  binIndexForValue,
  buildTourismNutsCollection,
  computeQuantileBreaks,
  parseJsonStatLatestValues,
  type GiscoNutsFeatureCollection,
  type JsonStatResponse,
  type TourismNutsCollection,
} from './eurostat-tourism-nuts'
// The import path lives in its own module (see eurostat-tourism-nuts-import.ts);
// its tests stay here with the rest of the cluster, same convention as
// eu-flood-risk.test.ts / eu-flood-risk-import.ts.
import { importEurostatTourismNutsCache } from './eurostat-tourism-nuts-import'

describe('computeQuantileBreaks', () => {
  it('returns numBins-1 interior break points via linear interpolation', () => {
    // sorted: 10,20,30,40,50,60 — 3 bins -> breaks at p=1/3 and p=2/3
    const breaks = computeQuantileBreaks([60, 10, 40, 20, 50, 30], 3)
    expect(breaks).toHaveLength(2)
    expect(breaks[0]).toBeCloseTo(26.666, 2)
    expect(breaks[1]).toBeCloseTo(43.333, 2)
  })

  it('returns an empty array for no values or fewer than 2 bins', () => {
    expect(computeQuantileBreaks([], 6)).toEqual([])
    expect(computeQuantileBreaks([1, 2, 3], 1)).toEqual([])
  })

  it('produces duplicate breaks (collapsed bins) when the data is heavily tied, without throwing', () => {
    const breaks = computeQuantileBreaks([5, 5, 5, 5, 5, 100], 6)
    expect(breaks.every((b) => Number.isFinite(b))).toBe(true)
    // Most break points fall inside the tied run and come out identical —
    // this is the accepted behaviour (see binIndexForValue), not a bug.
    expect(new Set(breaks).size).toBeLessThan(breaks.length)
  })

  it('collapses every value into the top bin when all inputs are equal', () => {
    const breaks = computeQuantileBreaks([7, 7, 7, 7], 6)
    expect(breaks.every((b) => b === 7)).toBe(true)
    expect(binIndexForValue(7, breaks)).toBe(breaks.length)
  })
})

describe('binIndexForValue', () => {
  const breaks = [10, 20, 30]

  it('bins strictly-below values into bin 0', () => {
    expect(binIndexForValue(5, breaks)).toBe(0)
  })

  it('puts a value exactly on a break into the upper (darker) bin', () => {
    expect(binIndexForValue(10, breaks)).toBe(1)
    expect(binIndexForValue(20, breaks)).toBe(2)
    expect(binIndexForValue(30, breaks)).toBe(3)
  })

  it('bins a value above every break into the topmost bin', () => {
    expect(binIndexForValue(1000, breaks)).toBe(3)
  })
})

function jsonStatFixture(): JsonStatResponse {
  return {
    // Pinned dims (unit/c_resid/nace_r2/freq) all size 1, placed before the
    // two free dims — verifies computeOffset correctly contributes 0 for
    // them regardless of position, not just when they're absent.
    id: ['unit', 'c_resid', 'nace_r2', 'freq', 'geo', 'time'],
    size: [1, 1, 1, 1, 2, 3],
    dimension: {
      unit: { category: { index: { P_KM2: 0 } } },
      c_resid: { category: { index: { TOTAL: 0 } } },
      nace_r2: { category: { index: { 'I551-I553': 0 } } },
      freq: { category: { index: { A: 0 } } },
      geo: { category: { index: { AT11: 0, AT12: 1 } } },
      time: { category: { index: { '2023': 0, '2024': 1, '2025': 2 } } },
    },
    value: {
      // AT11: only 2023 reported (offset 0*3+0=0).
      '0': 12.5,
      // AT12: reported 2024 (offset 1*3+1=4) and 2025 (offset 1*3+2=5) —
      // the newer one must win.
      '4': 35,
      '5': 40,
    },
  }
}

describe('parseJsonStatLatestValues', () => {
  it('picks each region\'s own most recent non-null year and skips regions absent from the geo dimension', () => {
    const result = parseJsonStatLatestValues(jsonStatFixture(), ['AT11', 'AT12', 'AT13'])
    expect(result.get('AT11')).toEqual({ value: 12.5, dataYear: '2023' })
    expect(result.get('AT12')).toEqual({ value: 40, dataYear: '2025' })
    expect(result.has('AT13')).toBe(false)
  })
})

function giscoFixture(): GiscoNutsFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'AT11', na: 'Wien' },
        geometry: { type: 'Polygon', coordinates: [[[16, 48], [16.5, 48], [16.5, 48.5], [16, 48]]] },
      },
      {
        type: 'Feature',
        properties: { id: 'AT12', na: 'Niederösterreich' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[15, 48], [15.5, 48], [15.5, 48.5], [15, 48]]],
            [[[17, 48], [17.5, 48], [17.5, 48.5], [17, 48]]],
          ],
        },
      },
      // Present in GISCO but has no Eurostat figure at all — must survive as
      // value: null / bin: null, never silently dropped.
      {
        type: 'Feature',
        properties: { id: 'AT13', na: 'Kärnten' },
        geometry: { type: 'Polygon', coordinates: [[[14, 46], [14.5, 46], [14.5, 46.5], [14, 46]]] },
      },
    ],
  }
}

describe('buildTourismNutsCollection', () => {
  it('joins GISCO geometry with Eurostat values, bins them, and keeps Polygon/MultiPolygon/no-data regions all present', () => {
    const values = new Map([
      ['AT11', { value: 10, dataYear: '2024' }],
      ['AT12', { value: 100, dataYear: '2024' }],
    ])
    const collection = buildTourismNutsCollection(giscoFixture(), values, {
      generatedAt: '2026-08-22T00:00:00.000Z',
      sourceVersion: 'test-v1',
      numBins: 2,
    })

    expect(collection.unit).toBe('P_KM2')
    expect(collection.breaks).toEqual([55])
    expect(collection.regions).toHaveLength(3)

    const at11 = collection.regions.find((r) => r.nutsId === 'AT11')!
    expect(at11).toMatchObject({ value: 10, dataYear: '2024', bin: 0 })
    expect(at11.geometry.type).toBe('Polygon')

    const at12 = collection.regions.find((r) => r.nutsId === 'AT12')!
    expect(at12).toMatchObject({ value: 100, dataYear: '2024', bin: 1, countryCode: 'AT' })
    expect(at12.geometry.type).toBe('MultiPolygon')

    const at13 = collection.regions.find((r) => r.nutsId === 'AT13')!
    expect(at13).toMatchObject({ value: null, dataYear: null, bin: null })
  })
})

let tmp: string | null = null

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

describe('importEurostatTourismNutsCache', () => {
  it('fetches GISCO boundaries and Eurostat statistics, joins them, and writes the merged cache file', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'eurostat-tourism-nuts-'))
    const cachePath = join(tmp, 'eurostat-tourism-nuts.json')

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.includes('Nuts2json')) {
        return new Response(JSON.stringify(giscoFixture()), { status: 200 })
      }
      if (href.includes('tour_occ_nin2')) {
        expect(href).toContain('sinceTimePeriod=2022')
        return new Response(JSON.stringify(jsonStatFixture()), { status: 200 })
      }
      throw new Error(`unexpected URL: ${href}`)
    })

    const summary = await importEurostatTourismNutsCache({
      cachePath,
      currentYear: 2025,
      generatedAt: '2026-08-22T00:00:00.000Z',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(summary.regionCount).toBe(3)
    // AT13 is in the GISCO fixture but not in the Eurostat fixture's geo
    // dimension at all — must be written with a null value, never dropped.
    expect(summary.regionsWithData).toBe(2)

    const written = JSON.parse(await readFile(cachePath, 'utf8')) as TourismNutsCollection
    expect(written.regions).toHaveLength(3)
    expect(written.regions.find((r) => r.nutsId === 'AT11')).toMatchObject({ value: 12.5, dataYear: '2023' })
    expect(written.regions.find((r) => r.nutsId === 'AT13')).toMatchObject({ value: null, bin: null })
  })

  it('throws instead of writing a cache file when the GISCO response has the wrong shape', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'eurostat-tourism-nuts-'))
    const cachePath = join(tmp, 'eurostat-tourism-nuts.json')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ not: 'a feature collection' }), { status: 200 }))

    await expect(importEurostatTourismNutsCache({
      cachePath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/GISCO NUTS2 response/)

    await expect(readFile(cachePath, 'utf8')).rejects.toThrow()
  })

  it('throws instead of overwriting the cache when GISCO returns zero regions', async () => {
    // isGiscoNutsFeatureCollection() passes an empty features array
    // vacuously (Array.prototype.every on []) — this guards the case a
    // truncated/empty GISCO response would otherwise silently blank out an
    // existing good cache file.
    tmp = await mkdtemp(join(tmpdir(), 'eurostat-tourism-nuts-'))
    const cachePath = join(tmp, 'eurostat-tourism-nuts.json')
    const existing: TourismNutsCollection = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      sourceVersion: 'previous-good-run',
      unit: 'P_KM2',
      breaks: [1],
      regions: [{ nutsId: 'AT11', name: 'Wien', countryCode: 'AT', value: 5, dataYear: '2024', bin: 0, geometry: { type: 'Polygon', coordinates: [] } }],
    }
    await writeFile(cachePath, JSON.stringify(existing))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))

    await expect(importEurostatTourismNutsCache({
      cachePath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/no regions/)

    const untouched = JSON.parse(await readFile(cachePath, 'utf8')) as TourismNutsCollection
    expect(untouched).toEqual(existing)
  })
})
