import { describe, expect, it } from 'vitest'
import { buildLeisureTourismProfiles, type LeisureTourismMetricsInput } from './leisure-tourism-profile'

const NOTHING_NEARBY: LeisureTourismMetricsInput = {
  distSkiM: null,
  distSeaM: null,
  distLakeM: null,
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

  it('reaches an overall sehr_gut for the doc\'s own worked example, even though the ski distance alone only rates gut', () => {
    // The doc's example text ("Freizeit & Tourismus: sehr gut — Skigebiet 23
    // km …") is the *combined* verdict, not a claim that 23km alone is the
    // best ski band — by the doc's own step-3 thresholds (<15km sehr gut)
    // 23km lands in "gut". The other four criteria being sehr_gut pulls the
    // weighted average back up to an overall sehr_gut.
    const metrics: LeisureTourismMetricsInput = {
      ...NOTHING_NEARBY,
      distSkiM: 23_000, // doc example: "Skigebiet 23 km (Vitosha)"
      distLakeM: 1_800, // doc example: "Badesee 1,8 km"
      distHikingM: 200,
      tourismDensityCount: 34,
      attractionDensityCount: 12,
    }
    const profiles = buildLeisureTourismProfiles(metrics)
    expect(profiles.wirtschaftlich.criteria!.ski).toEqual({ band: 'gut', value: 23_000 })
    expect(profiles.wirtschaftlich.criteria!.wasser).toEqual({ band: 'sehr_gut', value: 1_800, source: 'lake' })
    expect(profiles.wirtschaftlich.label).toBe('sehr_gut')
  })

  it('prefers the nearer of sea/lake and tags the correct source', () => {
    const nearSea = buildLeisureTourismProfiles({ ...NOTHING_NEARBY, distSeaM: 5_000, distLakeM: 40_000 })
    expect(nearSea.eigennutzung.criteria!.wasser).toMatchObject({ source: 'sea', value: 5_000 })

    const nearLake = buildLeisureTourismProfiles({ ...NOTHING_NEARBY, distSeaM: 40_000, distLakeM: 5_000 })
    expect(nearLake.eigennutzung.criteria!.wasser).toMatchObject({ source: 'lake', value: 5_000 })
  })

  it('the most important test: the two profiles must diverge for an airport-adjacent object', () => {
    // Weighting only differs for the tourism-relevant criteria here (ski/
    // wasser/wandern/dichte/sehenswürdigkeiten) — airport proximity itself
    // isn't one of them, so this test instead exercises the one axis WP-8
    // *does* weight differently: a strong touristic profile that both
    // Eigennutzung (weighted "mittel"/"niedrig") and wirtschaftliche Nutzung
    // (weighted "hoch") must score, but not identically — the fix under
    // test is that the weighting isn't a no-op.
    const metrics: LeisureTourismMetricsInput = {
      distSkiM: 10_000,
      distSeaM: 2_000,
      distLakeM: null,
      distHikingM: 1_000,
      tourismDensityCount: 25,
      attractionDensityCount: 15,
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
      distLakeM: null, // wasser: gering
      distHikingM: 1_000, // sehr_gut
      tourismDensityCount: 1, // below the maessig floor (2) → gering
      attractionDensityCount: 0, // gering
    }
    const divergent = buildLeisureTourismProfiles(mixed)
    // Eigennutzung weighs ski/wasser/wandern more, wirtschaftlich weighs
    // dichte/sehenswürdigkeiten equally to the rest — with two "gering" and
    // two "sehr_gut" plus one "gering", the profiles must land on different
    // labels for the weighting to be meaningful.
    expect(divergent.eigennutzung.label).not.toBe(divergent.wirtschaftlich.label)
  })

  it('an object with only a partial metrics row still gets a judgement, not keine_angaben', () => {
    // A real row exists (unlike the top-level null case) — individual NULL
    // columns within it are legitimate "nothing of this kind" facts, not a
    // reason to withhold the whole assessment.
    const profiles = buildLeisureTourismProfiles({
      distSkiM: null,
      distSeaM: 1_000,
      distLakeM: null,
      distHikingM: null,
      tourismDensityCount: 0,
      attractionDensityCount: 0,
    })
    expect(profiles.eigennutzung.label).not.toBe('keine_angaben')
    expect(profiles.eigennutzung.criteria).not.toBeNull()
  })
})
