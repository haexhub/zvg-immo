import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { parseDetailPage, enrichOne } from './detail'
import { parseLtArea } from './text'

/** Trimmed-down auction.do markup (verified against live ids 333292/331902). */
const PLOT_FIXTURE = `
<ul class="info">
  <li><span class="left">Parduodamo turto vieta:</span><span class="right">
    <a href="https://www.eaukcionai.lt/evs/pages/map/photo.jpg?mapObjectId=1261636&amp;mapScale=1000"
       rel="galleryMapPhotos" class="url fancybox-map fancybox.image hidden">Žemėlapis</a>
  </span></li>
  <li><span class="left">Bendras turto plotas:</span><span class="right">13&#32; a.&#32; (0,13 &#32;ha.)</span></li>
  <li><span class="left">Turto potipis:</span><span class="right">Sklypai</span></li>
  <li><span class="left">Aprašymas:</span><span class="right">Parduodamas 0.13 ha žemės sklypas, esantis Ignalinos r.sav., Rimšė.
Daikto pagrindinė naudojimo paskirtis:Žemės ūkio</span></li>
</ul>`

const FLAT_FIXTURE = `
<ul class="info">
  <li><span class="left">Bendras turto plotas:</span><span class="right">10,68&#32; kv. m</span></li>
  <li><span class="left">Turto potipis:</span><span class="right">Patalpos/Butai</span></li>
  <li><span class="left">Aprašymas:</span><span class="right">Parduodamos sandėliavimo patalpos.</span></li>
</ul>
<a href="/evap-image/image/331902/889118/hd" class="fancybox-gallery fancybox.image" rel="gallery422440">1</a>
<a href="/evap-image/image/331902/889119/hd" class="fancybox-gallery fancybox.image" rel="gallery422440">2</a>
<a href="/evap-image/image/331902/889118/hd" class="fancybox-gallery fancybox.image" rel="gallery422440">dup</a>`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'lt-eaukcionai',
    country: 'lt',
    region: '',
    zvgId: '333292',
    aktenzeichen: '329744',
    amtsgericht: '',
    objekt: 'Žemės sklypas',
    adresse: null,
    verkehrswertEur: 39168,
    verkehrswertText: '39.168 €',
    terminIso: null,
    terminText: null,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.eaukcionai.lt/evs/pages/auction.do?id=333292&number=329744',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.eaukcionai.lt/evs/pages/auction.do?id=333292&number=329744',
    attachments: [],
    beschreibung: null,
    fotoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('parseLtArea', () => {
  it('parses "kv. m" values', () => {
    expect(parseLtArea('10,68 kv. m')).toBe(10.68)
  })

  it('parses Ar ("a") values to m²', () => {
    expect(parseLtArea('13 a. (0,13 ha.)')).toBe(1300)
  })

  it('parses hectare values to m²', () => {
    expect(parseLtArea('2,5 ha')).toBe(25000)
  })

  it('returns null for text without a recognised unit', () => {
    expect(parseLtArea('nenurodyta')).toBeNull()
  })
})

describe('parseDetailPage', () => {
  it('extracts description, area, subtype and skips the map placeholder gallery', () => {
    const d = parseDetailPage(PLOT_FIXTURE)
    expect(d.beschreibung).toBe(
      'Parduodamas 0.13 ha žemės sklypas, esantis Ignalinos r.sav., Rimšė.\nDaikto pagrindinė naudojimo paskirtis:Žemės ūkio',
    )
    expect(d.areaRaw).toBe('13 a. (0,13 ha.)')
    expect(d.areaSqm).toBe(1300)
    expect(d.potipis).toBe('Sklypai')
    expect(d.photoUrls).toEqual([])
  })

  it('collects deduped absolute gallery photo urls', () => {
    const d = parseDetailPage(FLAT_FIXTURE)
    expect(d.photoUrls).toEqual([
      'https://www.eaukcionai.lt/evap-image/image/331902/889118/hd',
      'https://www.eaukcionai.lt/evap-image/image/331902/889119/hd',
    ])
    expect(d.areaSqm).toBe(10.68)
  })
})

describe('enrichOne', () => {
  it('fills beschreibung and land area for a plot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(PLOT_FIXTURE)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.beschreibung).toContain('Parduodamas 0.13 ha žemės sklypas')
    expect(a.sourceLandAreaSqm).toBe(1300)
    expect(a.sourceLivingAreaSqm).toBeUndefined()
    expect(a.photoUrls).toBeUndefined()
    expect(a.fotoCount).toBe(0)
  })

  it('fills living area and photos for a flat/premises lot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(FLAT_FIXTURE)))
    const a = makeAuction({ objekt: 'Sandėliavimo patalpos' })
    await enrichOne(a)
    expect(a.sourceLivingAreaSqm).toBe(10.68)
    expect(a.sourceLandAreaSqm).toBeUndefined()
    expect(a.photoUrls).toHaveLength(2)
    expect(a.fotoCount).toBe(2)
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('503')
  })
})
