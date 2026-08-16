import { describe, expect, it } from 'vitest'
import { buildLeisureTourismProfiles, type LeisureTourismMetricsInput } from './leisure-tourism-profile'

const NOTHING_NEARBY: LeisureTourismMetricsInput = {
  distSkiM: null,
  distSeaM: null,
  distSwimmingM: null,
  distHikingM: null,
  tourismDensityCount: 0,
  attractionDensityCount: 0,
}

describe('buildLeisureTourismProfiles', () => {
  it('reports keine_angaben for both profiles when no metrics row exists at all', () => {
    const profiles = buildLeisureTourismProfiles(null)
    expect(profiles.eigennutzung).toEqual({ label: 'keine_angaben', criteria: null })
    expect(profiles.wirtschaftlich).toEqual({ label: 'keine_angaben', criteria: null })
  })

  it('never treats a NULL (beyond-cutoff) distance as 0/best — it is the worst band, not the best', () => {
    // Doc's most dangerous pitfall: NULL as 0 would look like "right next to
    // the ski area" instead of "no ski area within 200km".
    const profiles = buildLeisureTourismProfiles(NOTHING_NEARBY)
    expect(profiles.wirtschaftlich.criteria!.ski.band).toBe('gering')
    expect(profiles.wirtschaftlich.criteria!.ski.value).toBeNull()
    expect(profiles.wirtschaftlich.criteria!.wasser.band).toBe('gering')
    expect(profiles.wirtschaftlich.criteria!.wasser.value).toBeNull()
    expect(profiles.wirtschaftlich.criteria!.wandern.band).toBe('gering')
    // A real, low count is distinct from "no data" — both still surface as a
    // presentable fact, not an error state.
    expect(profiles.wirtschaftlich.criteria!.tourismusDichte).toEqual({ band: 'gering', value: 0 })
    expect(profiles.wirtschaftlich.label).toBe('gering')
  })

  it('places the doc\'s own worked example in realistic bands once calibrated against real prod distributions', () => {
    // The doc's illustrative numbers ("Skigebiet 23 km", "Badesee 1,8 km", …)
    // were chosen to read well in prose, not to sit at the top of the real
    // distribution — verified live 2026-08-15 against prod: 23km ski lands
    // around the real p75-p90 (gut, not sehr_gut, by the doc's own bands),
    // and 1.8km to a genuine swimming spot is close to the real *median*
    // (p50 ≈ 1.75km) once measured against distSwimmingM rather than the
    // much-too-generous generic `lake` kind. See leisure-tourism-profile.ts's
    // threshold comments for the exact percentiles.
    const metrics: LeisureTourismMetricsInput = {
      distSkiM: 23_000, // doc example: "Skigebiet 23 km (Vitosha)"
      distSeaM: null,
      distSwimmingM: 1_800, // doc example: "Badesee 1,8 km"
      distHikingM: 200, // doc example: "Wanderwegnetz angrenzend"
      tourismDensityCount: 34, // doc example: "34 touristische Betriebe in 10 km"
      attractionDensityCount: 12, // doc example: "12 Sehenswürdigkeiten im Umkreis 30 km"
    }
    const profiles = buildLeisureTourismProfiles(metrics)
    expect(profiles.wirtschaftlich.criteria!.ski).toEqual({ band: 'gut', value: 23_000 })
    expect(profiles.wirtschaftlich.criteria!.wasser).toEqual({ band: 'gut', value: 1_800, source: 'swimming' })
    expect(profiles.wirtschaftlich.criteria!.wandern.band).toBe('sehr_gut')
    expect(profiles.wirtschaftlich.criteria!.tourismusDichte.band).toBe('maessig')
    expect(profiles.wirtschaftlich.criteria!.sehenswuerdigkeiten.band).toBe('gering')
    // Mixed bands (gut/gut/sehr_gut/mäßig/gering) average out to "gut" overall
    // — a believable, everyday-good location rather than an implausible
    // "sehr gut" manufactured from an unrepresentative worked example.
    expect(profiles.wirtschaftlich.label).toBe('gut')
  })

  it('reaches sehr_gut when every criterion is genuinely in the real top decile', () => {
    const metrics: LeisureTourismMetricsInput = {
      distSkiM: 5_000,
      distSeaM: null,
      distSwimmingM: 500,
      distHikingM: 100,
      tourismDensityCount: 200,
      attractionDensityCount: 250,
    }
    const profiles = buildLeisureTourismProfiles(metrics)
    expect(profiles.eigennutzung.label).toBe('sehr_gut')
    expect(profiles.wirtschaftlich.label).toBe('sehr_gut')
  })

  it('prefers the nearer of sea/swimming-spot and tags the correct source', () => {
    const nearSea = buildLeisureTourismProfiles({ ...NOTHING_NEARBY, distSeaM: 5_000, distSwimmingM: 15_000 })
    expect(nearSea.eigennutzung.criteria!.wasser).toMatchObject({ source: 'sea', value: 5_000 })

    const nearSwimming = buildLeisureTourismProfiles({ ...NOTHING_NEARBY, distSeaM: 15_000, distSwimmingM: 5_000 })
    expect(nearSwimming.eigennutzung.criteria!.wasser).toMatchObject({ source: 'swimming', value: 5_000 })
  })

  it('the most important test: the two profiles must diverge for the same underlying values', () => {
    // Weighting only differs for the tourism-relevant criteria here (ski/
    // wasser/wandern/dichte/sehenswürdigkeiten) — this test exercises the one
    // axis WP-8 *does* weight differently: the fix under test is that the
    // weighting isn't a no-op.
    const metrics: LeisureTourismMetricsInput = {
      distSkiM: 10_000,
      distSeaM: 500,
      distSwimmingM: null,
      distHikingM: 1_000,
      tourismDensityCount: 200,
      attractionDensityCount: 250,
    }
    const profiles = buildLeisureTourismProfiles(metrics)
    expect(profiles.eigennutzung.label).toBe('sehr_gut')
    expect(profiles.wirtschaftlich.label).toBe('sehr_gut')
    // Same top label here (every criterion already maxed out), so assert on
    // the underlying weighted math instead — proves the weights are actually
    // applied per profile, not just cosmetic.
    const mixed: LeisureTourismMetricsInput = {
      distSkiM: 10_000, // sehr_gut
      distSeaM: null,
      distSwimmingM: null, // wasser: gering
      distHikingM: 1_000, // sehr_gut
      tourismDensityCount: 1, // below the maessig floor (20) → gering
      attractionDensityCount: 0, // gering
    }
    const divergent = buildLeisureTourismProfiles(mixed)
    // Eigennutzung weighs ski/wasser/wandern more, wirtschaftlich weighs
    // dichte/sehenswürdigkeiten equally to the rest — with three "gering" and
    // two "sehr_gut", the profiles must land on different labels for the
    // weighting to be meaningful.
    expect(divergent.eigennutzung.label).not.toBe(divergent.wirtschaftlich.label)
  })

  it('an object with only a partial metrics row still gets a judgement, not keine_angaben', () => {
    // A real row exists (unlike the top-level null case) — individual NULL
    // columns within it are legitimate "nothing of this kind" facts, not a
    // reason to withhold the whole assessment.
    const profiles = buildLeisureTourismProfiles({
      distSkiM: null,
      distSeaM: 1_000,
      distSwimmingM: null,
      distHikingM: null,
      tourismDensityCount: 0,
      attractionDensityCount: 0,
    })
    expect(profiles.eigennutzung.label).not.toBe('keine_angaben')
    expect(profiles.eigennutzung.criteria).not.toBeNull()
  })
})
