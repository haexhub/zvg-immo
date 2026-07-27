import { describe, expect, it } from 'vitest'
import { EXTERNAL_DATA_SOURCES, sourcesForCapability, sourcesForCountry } from './sources'

describe('external data source registry', () => {
  it('gives every adapter a display label and source URL', () => {
    for (const source of EXTERNAL_DATA_SOURCES) {
      expect(source.adapter).toMatch(/\w+Adapter$/)
      expect(source.label).toBeTruthy()
      expect(source.sourceUrl).toMatch(/^https:\/\//)
    }
  })

  it('can select country-specific sources plus EU-wide baseline sources', () => {
    const ids = sourcesForCountry('de').map((source) => source.id)
    expect(ids).toContain('de-boris-d')
    expect(ids).toContain('eu-flood-risk-areas')
    expect(ids).toContain('copernicus-effis')
  })

  it('can select sources by capability', () => {
    expect(sourcesForCapability('hazard_flood').map((source) => source.id)).toContain('eu-flood-risk-areas')
    expect(sourcesForCapability('market_transactions').map((source) => source.id)).toEqual(['fr-dvf-geolocated'])
  })
})
