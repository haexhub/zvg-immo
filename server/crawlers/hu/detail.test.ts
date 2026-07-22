import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { parseDetailPage, enrichOne } from './detail'
import { jsFieldValue, jsFieldUnit } from './text'

/** Property-sheet script blocks as MNV renders them (verified live, id 48407). */
const SHEET_JS = `
<tr><td>Helyrajzi szám</td><td><span id="place_num_34997"></span>
  <script type="text/javascript">
  <!--
      var selVal = '141/6';
      var itemId = 'place_num_34997';
      var span = document.getElementById(itemId);
      span.innerHTML=selVal;
  // -->
  </script>
</td></tr>
<tr><td>Terület</td><td><span id="estate_square_34997"></span>
  <script type="text/javascript">
  <!--
      var selVal = formattedNumber(parseFloat('9 643'.replace(',','.').replace(' ','')).toFixed(2)).toString().replace('.',',');
      var itemId = 'estate_square_34997';
      var span = document.getElementById(itemId);
      span.innerHTML = selVal;
      var selVal2 = 'm2';
      span.innerHTML = span.innerHTML + ' ' + selVal2;
  // -->
  </script>
</td></tr>`

/** ASCII-safe fixture: enrichOne round-trips the body through the ISO-8859-2
 *  decoder, which would garble UTF-8 accents in a JS string literal. */
const DETAIL_FIXTURE = `
<table>
<tr id="description">
<th style="width: 260px;">Egy&#233;b inf&#243;:</th><td>Az ingatlan fel&#233;p&#237;tm&#233;ny n&#233;lk&#252;li, kivett be&#233;p&#237;tetlen ter&#252;let.<br>
<br>
B&#337;vebb inform&#225;ci&#243;kat az &#225;rver&#233;si hirdetm&#233;ny tartalmaz.</td>
</tr>
</table>
${SHEET_JS}
<div class="image-gallery">
<img fullurl="pictures/c/1b/95243.jpg" position="0" src="pictures/c/1b/95243.jpg"><img fullurl="pictures/7/6/95244.jpg" position="1" src="pictures/7/6/95244.jpg"><img fullurl="pictures/c/1b/95243.jpg" position="2" src="pictures/c/1b/95243.jpg">
</div>
<img src="maps/api/staticmap?size=300x200&amp;zoom=15&amp;markers= 48.323043, 22.041670" class="gmap-image">`

const PRICE_ROWS = `
<table>
<tr><th>Becsérték:</th><td>5 000 000 HUF</td></tr>
<tr><th>Kikiáltási ár:</th><td>3 900 000 HUF
                    </td></tr>
<tr><th>Kikiáltási ár ÁFA tartalma:</th><td>27%</td></tr>
</table>`

/** Same rows as PRICE_ROWS, entity-encoded (see DETAIL_FIXTURE comment) so
 *  enrichOne's ISO-8859-2 round-trip doesn't garble the "Becsérték"/
 *  "Kikiáltási ár" labels it matches on. */
const PRICE_ROWS_ASCII_SAFE = `
<table>
<tr><th>Becs&#233;rt&#233;k:</th><td>5 000 000 HUF</td></tr>
<tr><th>Kiki&#225;lt&#225;si &#225;r:</th><td>3 900 000 HUF
                    </td></tr>
</table>`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'hu-mnv',
    country: 'hu',
    region: '',
    externalId: '48407',
    caseNumber: '49866/260702',
    authority: '',
    title: 'Beépitetlen terület',
    address: 'Révleányvár, Ungarn',
    marketValueEur: 9800,
    marketValueText: '3.900.000 Ft',
    startingBid: 3_900_000,
    auctionDateIso: '2026-07-27',
    auctionDateText: '2026.07.27. 21:00',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://e-arveres.mnv.hu/index-meghirdetesek-ingatlan.html?.actionId=action.auction.AuctionSummaryAction&auctionId=48407',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://e-arveres.mnv.hu/index-meghirdetesek-ingatlan.html?.actionId=action.auction.AuctionSummaryAction&auctionId=48407',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://e-arveres.mnv.hu/pictures/thumb.jpg',
    ...overrides,
  }
}

// archiveDetailCapture (called from enrichOne) goes through getPool(), which
// reads useRuntimeConfig().databaseUrl — undefined here, so it safely no-ops.
beforeEach(() => vi.stubGlobal('useRuntimeConfig', () => ({})))
afterEach(() => vi.unstubAllGlobals())

describe('jsFieldValue / jsFieldUnit', () => {
  it('extracts text fields', () => {
    expect(jsFieldValue(SHEET_JS, 'place_num')).toBe('141/6')
  })

  it('extracts numeric fields with their unit', () => {
    expect(jsFieldValue(SHEET_JS, 'estate_square')).toBe('9 643')
    expect(jsFieldUnit(SHEET_JS, 'estate_square')).toBe('m2')
  })

  it('returns null for absent fields', () => {
    expect(jsFieldValue(SHEET_JS, 'estate_owner')).toBeNull()
    expect(jsFieldUnit(SHEET_JS, 'place_num')).toBeNull()
  })
})

describe('parseDetailPage', () => {
  it('extracts description, cadastral number, area, photos and coordinates', () => {
    const d = parseDetailPage(DETAIL_FIXTURE)
    expect(d.description).toBe(
      'Az ingatlan felépítmény nélküli, kivett beépítetlen terület.\n\nBővebb információkat az árverési hirdetmény tartalmaz.',
    )
    expect(d.helyrajziSzam).toBe('141/6')
    expect(d.areaSqm).toBe(9643)
    expect(d.areaRaw).toBe('9 643 m2')
    expect(d.photoUrls).toEqual([
      'https://e-arveres.mnv.hu/pictures/c/1b/95243.jpg',
      'https://e-arveres.mnv.hu/pictures/7/6/95244.jpg',
    ])
    expect(d.lat).toBe(48.323043)
    expect(d.lng).toBe(22.04167)
  })

  it('reads Becsérték and the exact "Kikiáltási ár:" row (not the ÁFA row)', () => {
    const d = parseDetailPage(PRICE_ROWS)
    expect(d.becsertekHuf).toBe(5_000_000)
    expect(d.kikialtasiRaw).toBe('3 900 000 HUF')
  })

  it('leaves becsérték null when the lot only lists a starting price', () => {
    const d = parseDetailPage(DETAIL_FIXTURE)
    expect(d.becsertekHuf).toBeNull()
  })
})

describe('enrichOne', () => {
  it('fills description with labelled cadastre/area lines, land area, photos and coords', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_FIXTURE)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.description).toContain('kivett beépítetlen terület')
    expect(a.description).toContain('Helyrajzi szám: 141/6')
    expect(a.description).toContain('Terület: 9 643 m2')
    expect(a.sourceLandAreaSqm).toBe(9643)
    expect(a.photoUrls).toHaveLength(2)
    expect(a.photoCount).toBe(2)
    expect(a.lat).toBe(48.323043)
    expect(a.lng).toBe(22.04167)
    // No Becsérték on the page → the list price stays untouched.
    expect(a.marketValueEur).toBe(9800)
    // startingBid is set from the list page only; enrichOne never touches it.
    expect(a.startingBid).toBe(3_900_000)
  })

  it('keeps startingBid unchanged when a Becsérték valuation overrides marketValue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(PRICE_ROWS_ASCII_SAFE)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.marketValue).toBe(5_000_000)
    expect(a.startingBid).toBe(3_900_000)
  })

  it('keeps the area out of the structured fields for built-up lots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_FIXTURE)))
    const a = makeAuction({ title: 'Lakóház' })
    await enrichOne(a)
    expect(a.sourceLandAreaSqm).toBeUndefined()
    expect(a.description).toContain('Terület: 9 643 m2')
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('500')
  })
})
