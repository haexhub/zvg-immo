import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeLtAddress, normalizeEeAddress, normalizeLvAddress, normalizeSeAddress } from './geocode'

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

// oksjonikeskus.ee addresses chain admin units before the street like LT, but
// keeping the street-type abbreviation ("tn", "mnt", "pst") breaks the match —
// OSM stores the bare street name. The expected forms were verified live
// against Nominatim (54/55 real listings resolved, up from 18/60 unnormalized).
describe('normalizeEeAddress', () => {
  it('drops the street-type word and keeps the linnaosa as the primary city', () => {
    expect(normalizeEeAddress('Kohtla-Järve linn, Ahtme linnaosa, Sõpruse tn 12a'))
      .toEqual(['Sõpruse 12a, Ahtme', 'Sõpruse 12a'])
  })

  it('recognises "Tallinn" itself as ending in the "linn" locality suffix', () => {
    expect(normalizeEeAddress('Tallinn, Kangru tn 9')).toEqual(['Kangru 9, Tallinn', 'Kangru 9'])
  })

  it('does not mistake a street name ending in "küla" for a locality', () => {
    expect(normalizeEeAddress('Narva linn, Uusküla tn 21')).toEqual(['Uusküla 21, Narva', 'Uusküla 21'])
    expect(normalizeEeAddress('Kohtla-Järve linn, Järve linnaosa, Järveküla tee 52'))
      .toEqual(['Järveküla 52, Järve', 'Järveküla 52'])
  })

  it('splits a fused street type ("Keskpuiestee") and also tries the whole word', () => {
    expect(normalizeEeAddress('Lüganuse vald Kiviõli linn, Keskpuiestee 39')).toEqual([
      'Kesk 39, Kiviõli',
      'Kesk 39, Lüganuse',
      'Kesk 39',
      'Keskpuiestee 39, Kiviõli',
      'Keskpuiestee 39, Lüganuse',
      'Keskpuiestee 39',
    ])
  })

  it('drops the apartment part of a hyphenated house number', () => {
    expect(normalizeEeAddress('Kohtla-Järve linn, Järve linnaosa, Olevi tn 20-14'))
      .toEqual(['Olevi 20, Järve', 'Olevi 20'])
  })

  it('puts the farm/building name after the locality for streetless rural addresses', () => {
    expect(normalizeEeAddress('Muhu vald Koguva küla, Vanatoa')).toEqual(['Vanatoa, Koguva', 'Koguva', 'Vanatoa'])
  })

  it('resolves a multi-level admin chain to the innermost compound locality', () => {
    expect(normalizeEeAddress('Saaremaa vald Saare maakond vald, Mõisaküla, Raineri'))
      .toEqual(['Raineri, Mõisaküla', 'Mõisaküla', 'Raineri'])
  })

  it('takes only the first ";"-joined alternate listing', () => {
    expect(
      normalizeEeAddress('Kohtla-Järve linn, Sompa linnaosa, Ülase tänav 5 juurdelõige;Sompa linnaosa, Ülase tn 5'),
    ).toEqual(['Ülase 5, Sompa', 'Ülase 5'])
  })
})

// izsoles.ta.gov.lv addresses are already close to Nominatim-friendly; the
// failures are legal boilerplate, quoted farmstead names, apartment
// building-block suffixes, and — confirmed live — the dotted "pag."/"nov."
// abbreviations themselves, which fail to match while the full word resolves
// the identical query. Verified live: 97/119 sampled real listings resolved,
// up from 0/589 (never attempted) before this fix.
describe('normalizeLvAddress', () => {
  it('keeps a well-formed street address as-is', () => {
    expect(normalizeLvAddress('Akmeņu iela 5, Durbe, Dienvidkurzemes novads'))
      .toEqual(['Akmeņu iela 5, Durbe, Dienvidkurzemes novads', 'Dienvidkurzemes novads'])
  })

  it('strips an apartment/building-block suffix off the house number', () => {
    expect(normalizeLvAddress('Latgales iela 260- k-4-36, Rīga'))
      .toEqual(['Latgales iela 260, Rīga', 'Latgales iela 260- k-4-36, Rīga'])
  })

  it('strips the "Apbūves tiesības uz zemes vienības daļu" legal prefix', () => {
    expect(normalizeLvAddress('Apbūves tiesības uz zemes vienības daļu Beverīnas ielā 3, Valka, Valkas novads'))
      .toEqual(['Beverīnas ielā 3, Valka, Valkas novads', 'Valkas novads'])
  })

  it('expands the dotted "pag."/"nov." abbreviations that fail to match as-is', () => {
    expect(normalizeLvAddress('Zemenes, Ezeres pag., Saldus nov.'))
      .toEqual(['Zemenes, Ezeres pagasts, Saldus novads', 'Ezeres pagasts', 'Saldus novads'])
  })

  it('strips quotes around a farmstead name', () => {
    expect(normalizeLvAddress('“Akoti”, Līgo pagasts, Gulbenes novads'))
      .toEqual(['Akoti, Līgo pagasts, Gulbenes novads', 'Līgo pagasts', 'Gulbenes novads'])
  })

  it('prefers a comma-structured ";"-segment over a bare name repeated first', () => {
    expect(normalizeLvAddress('Meža Būmeistari; "Meža Būmeistari", Nīcas pag., Dienvidkurzemes nov.'))
      .toEqual(['Meža Būmeistari, Nīcas pagasts, Dienvidkurzemes novads', 'Nīcas pagasts', 'Dienvidkurzemes novads'])
  })

  it('strips the "Dzīvokļa īpašuma ... izsole" wrapper', () => {
    expect(normalizeLvAddress('Dzīvokļa īpašuma Olaines ielā 7-8, Jelgavā izsole'))
      .toEqual(['Olaines ielā 7, Jelgavā', 'Olaines ielā 7-8, Jelgavā'])
  })

  it('strips a trailing cadastral reference number', () => {
    expect(normalizeLvAddress('Atmodas iela 97, Jelgava, kadastra Nr. 0900 011 0494'))
      .toEqual(['Atmodas iela 97, Jelgava'])
  })

  it('strips the "Neapbūvēta zemesgabala ... nomas tiesību elektroniska izsole" wrapper', () => {
    expect(normalizeLvAddress('Neapbūvēta zemesgabala Sēlpils ielā 13, Rīgā nomas tiesību elektroniska izsole'))
      .toEqual(['Sēlpils ielā 13, Rīgā'])
  })
})

describe('normalizeSeAddress', () => {
  it('falls back from a rural address to locality and municipality queries', () => {
    expect(normalizeSeAddress('Kvarnbyn 76, Burträsk, Skellefteå kommun')).toEqual([
      'Kvarnbyn 76, Burträsk, Skellefteå kommun',
      'Kvarnbyn 76, Burträsk, Skellefteå',
      'Kvarnbyn 76, Burträsk',
      'Kvarnbyn 76, Skellefteå',
      'Burträsk, Skellefteå',
      'Burträsk',
      'Skellefteå',
    ])
  })

  it('strips the "adress saknas" prefix but still uses the real address', () => {
    expect(normalizeSeAddress('adress saknas/Norrlimstavägen 33, Kramfors, Kramfors kommun')).toEqual([
      'Norrlimstavägen 33, Kramfors, Kramfors kommun',
      'Norrlimstavägen 33, Kramfors, Kramfors',
      'Norrlimstavägen 33, Kramfors',
      'Kramfors, Kramfors',
      'Kramfors',
    ])
  })

  it('tries both official genitive and base municipality names', () => {
    expect(normalizeSeAddress('Degerbäckens By 406, Boden, Bodens kommun')).toEqual([
      'Degerbäckens By 406, Boden, Bodens kommun',
      'Degerbäckens By 406, Boden, Bodens',
      'Degerbäckens By 406, Boden',
      'Degerbäckens By 406, Bodens',
      'Boden, Bodens',
      'Boden, Boden',
      'Boden',
      'Bodens',
    ])
  })

  it('keeps non-municipality two-part addresses usable', () => {
    expect(normalizeSeAddress('Stationsvägen 51, Skärblacka')).toEqual([
      'Stationsvägen 51, Skärblacka',
      'Skärblacka',
    ])
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
