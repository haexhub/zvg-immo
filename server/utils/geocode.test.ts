import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeLtAddress } from './geocode'

// eaukcionai.lt serves addresses as a chain of genitive administrative units
// plus a street. Nominatim only resolves the reduced "<street>, <city>" form,
// so normalizeLtAddress strips the admin prefixes and apartment suffix. The
// expected forms below were verified to resolve against live Nominatim.
describe('normalizeLtAddress', () => {
  it('reduces a city street address to "<street> <house>, <city>"', () => {
    expect(normalizeLtAddress('Klaipėdos m. sav. Klaipėdos m. Naujakiemio g. 25-57'))
      .toEqual(['Naujakiemio g. 25, Klaipėdos', 'Klaipėdos'])
  })

  it('keeps a house number without an apartment suffix', () => {
    expect(normalizeLtAddress('Klaipėdos m. sav. Klaipėdos m. Liepojos g. 152'))
      .toEqual(['Liepojos g. 152, Klaipėdos', 'Klaipėdos'])
  })

  it('keeps letters in the house number and handles "pr." (prospektas)', () => {
    expect(normalizeLtAddress('Vilniaus m. sav. Vilniaus m. Gedimino pr. 3A-1'))
      .toEqual(['Gedimino pr. 3A, Vilniaus', 'Vilniaus'])
  })

  it('keeps multi-token street names with initials', () => {
    expect(normalizeLtAddress('Plungės r. sav. Plungės m. S. Nėries g. 4-12'))
      .toEqual(['S. Nėries g. 4, Plungės', 'Plungės'])
  })

  it('uses the village (k./mstl.) as the city for rural streets', () => {
    expect(normalizeLtAddress('Vilniaus r. sav. Bezdonių mstl. Geležinkelio g. 24-7'))
      .toEqual(['Geležinkelio g. 24, Bezdonių', 'Bezdonių'])
  })

  it('collapses a street-less address to "<locality>, <district>"', () => {
    expect(normalizeLtAddress('Plungės r. sav. Kūbakių k.'))
      .toEqual(['Kūbakių, Plungės', 'Kūbakių'])
  })

  it('falls back to the raw address when it has no recognisable structure', () => {
    expect(normalizeLtAddress('Vilnius')).toEqual(['Vilnius'])
  })
})

// The geocoder backend is chosen at module load from process.env, so these
// tests re-import the module with the LocationIQ key set and a stubbed fetch.
describe('geocodeOnce (LocationIQ backend)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('treats a LocationIQ HTTP 404 as a cacheable not-found (null, not undefined)', async () => {
    vi.stubEnv('LOCATIONIQ_API_KEY', 'pk.test')
    vi.resetModules()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Unable to geocode"}', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { geocodeOnce } = await import('./geocode')
    const result = await geocodeOnce('Nowhere 1, Vilnius', 'lt')

    // null = "attempted, genuinely not found" (gets cached); undefined would be
    // an upstream error that is retried and counts toward the failure cooldown.
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
    const requestedUrl = String(fetchMock.mock.calls[0]![0])
    expect(requestedUrl).toContain('locationiq.com')
    expect(requestedUrl).toContain('key=pk.test')
  })
})
