import { describe, expect, it } from 'vitest'
import { parseAuctionsHtml } from './list'

// Real markup captured from https://www.zvg-portal.de (2026-08-13, land_abk=sn) —
// the portal renders Amtsgericht/Objekt-Lage/Verkehrswert in <strong> tags now,
// not the <b> tags the parser used to expect.
const STRONG_CHUNK = `<!--Aktenzeichen--->
		<TR><TD vAlign=top align=left ><nobr>Aktenzeichen&nbsp;&nbsp;</nobr></td><td vAlign=center align=left><strong>
		<a aria-label='Zwangsversteigerung Detailansicht' target=blank_ href=index.php?button=showZvg&zvg_id=40685&land_abk=sn>
		<nobr>0525 K 0116/2024&nbsp;(Detailansicht)</nobr></a></strong>&nbsp;</td>
		<TD vAlign=top align=right ><nobr>(letzte Aktualisierung 12-03-2026 14:27)</nobr></td></tr>
		<!--Amtsgericht--->
		<TR><TD vAlign=top align=left >Amtsgericht</td><td vAlign=center align=left  colspan=2><strong>Dresden in Sachsen</strong></td></tr>
		<TR ><TD vAlign=top align=left >Objekt/Lage</td><td vAlign=center align=left colspan=2><strong>Einfamilienhaus<!--Lage--->:</strong> G&ouml;ppersdorfer Stra&szlig;e 11c, 01819 Bahretal</td></tr>
  		<TR><TD vAlign=top align=left ><nobr>Verkehrswert in &#128;&nbsp;</nobr></td><td vAlign=center align=left  colspan=2><strong><p>95.000,00</p></strong></td></tr>
		<TR><TD vAlign=top align=left >Termin</td><td vAlign=center align=left
				colspan=2>Montag, 17. August 2026, 08:45 Uhr</td></tr><tr><td  colspan=3><hr></td></tr>
`

// Same fields, old <b> markup — kept working so historic/cached captures still parse.
const B_CHUNK = STRONG_CHUNK.replace(/<strong>/g, '<b>').replace(/<\/strong>/g, '</b>')

describe('parseAuctionsHtml', () => {
  it('extracts authority/title/address/market value from <strong>-tagged markup', () => {
    const { auctions } = parseAuctionsHtml(STRONG_CHUNK, 'sn', 'zvg-portal')
    expect(auctions).toHaveLength(1)
    const auction = auctions[0]!
    expect(auction.externalId).toBe('40685')
    expect(auction.caseNumber).toBe('0525 K 0116/2024')
    expect(auction.authority).toBe('Dresden')
    expect(auction.title).toBe('Einfamilienhaus')
    expect(auction.address).toBe('Göppersdorfer Straße 11c, 01819 Bahretal')
    expect(auction.marketValueEur).toBe(95000)
    expect(auction.cancelled).toBe(false)
  })

  it('still extracts the same fields from legacy <b>-tagged markup', () => {
    const { auctions } = parseAuctionsHtml(B_CHUNK, 'sn', 'zvg-portal')
    expect(auctions).toHaveLength(1)
    const auction = auctions[0]!
    expect(auction.authority).toBe('Dresden')
    expect(auction.title).toBe('Einfamilienhaus')
    expect(auction.address).toBe('Göppersdorfer Straße 11c, 01819 Bahretal')
    expect(auction.marketValueEur).toBe(95000)
  })
})
