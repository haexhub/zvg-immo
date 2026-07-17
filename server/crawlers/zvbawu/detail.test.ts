import { describe, expect, it } from 'vitest'
import { buildDetailInfo } from './detail'

/** Trimmed live payload of /zwangsversteigerungen/reihenendhaus-mit-garage.1253692
 *  (props.auction), fetched 2026-07-17. */
function auctionPayload() {
  return {
    id: 1253692,
    title: 'Reihenendhaus mit Garage',
    address: 'Mozartstraße 32, 76307 Karlsbad - Langensteinbach',
    auctionDate: '2026-07-22T08:00:00.000000Z',
    price: '495.000,00 €',
    fileNumber: '1 K 66/24',
    summary: '<p>Bei dem Versteigerungsobjekt handelt es sich um ein unterkellertes Einfamilienhaus (Reihenendhaus) mit Garage.</p>',
    description: '<h3>Gebäude</h3><p>Das Reihenendhaus wurde 1985 in Massivbauweise erbaut.</p>',
    teaser: 'Im Wege der Zwangsvollstreckung soll am Mittwoch, 22. Juli 2026 um 10:00 Uhr folgender Grundbesitz öffentlich versteigert werden:',
    interior: '<ul><li><p>Satteldach, Holzkonstruktion</p></li></ul><hr>',
    features: {
      badges: ['Balkon', 'Keller'],
      facts: [
        { key: 'Objekttyp', value: 'Reihenhaus' },
        { key: 'Wohnfläche', value: '179.95 m²' },
        { key: 'Grundstücksfläche', value: '448 m²' },
        { key: 'Heizungsart', value: 'Zentralheizung' },
        { key: 'Baujahr', value: '1985' },
      ],
    },
    facilities: {
      badges: [],
      facts: [],
      content: '<ul><li><p>Satteldach, Holzkonstruktion</p></li></ul><hr>',
    },
    accessories: { content: '' },
    location: {
      badges: [],
      facts: [{ key: 'Ort gemäß Gutachten', value: 'Karlsbad - Langensteinbach' }],
      content: '<p><strong>Karlsbad, Ortsteil Langensteinbach</strong></p><p>Mittlere bis gute Wohnlage.</p>',
    },
    bulletin: 'https://upload.immobilienpool.de/immobilien/00/01/25/36/92/TAB-1-K-66-24-ka.pdf',
    latlng: [48.907211, 8.505511] as [number, number],
    firstImage: {
      id: 9750186,
      thumbnail: 'https://upload.immobilienpool.de/immobilien/00/01/25/36/92/1_klein.jpg',
      url: 'https://upload.immobilienpool.de/immobilien/00/01/25/36/92/1.jpg',
      caption: '1',
    },
    images: [
      {
        id: 9750186,
        thumbnail: 'https://upload.immobilienpool.de/immobilien/00/01/25/36/92/1_klein.jpg',
        url: 'https://upload.immobilienpool.de/immobilien/00/01/25/36/92/1.jpg',
        caption: '1',
      },
    ],
    cancelled: false,
  }
}

describe('buildDetailInfo', () => {
  it('maps structured areas from features.facts', () => {
    const info = buildDetailInfo(auctionPayload())
    expect(info.sourceLivingAreaSqm).toBe(179.95)
    expect(info.sourceLandAreaSqm).toBe(448)
    expect(info.sourceRooms).toBeNull()
  })

  it('maps a Zimmer fact to sourceRooms', () => {
    const a = auctionPayload()
    a.features.facts.push({ key: 'Zimmer', value: '4,5' })
    expect(buildDetailInfo(a).sourceRooms).toBe(4.5)
  })

  it('composes teaser, summary/description, facts and sections into the beschreibung', () => {
    const info = buildDetailInfo(auctionPayload())
    const b = info.beschreibung ?? ''
    expect(b.startsWith('Im Wege der Zwangsvollstreckung')).toBe(true)
    expect(b).toContain('unterkellertes Einfamilienhaus')
    expect(b).toContain('Objekttyp: Reihenhaus')
    expect(b).toContain('Wohnfläche: 179.95 m²')
    expect(b).toContain('Ausstattung:\nSatteldach, Holzkonstruktion')
    expect(b).toContain('Lage:\nOrt gemäß Gutachten: Karlsbad - Langensteinbach')
    expect(b).toContain('Mittlere bis gute Wohnlage.')
    // interior duplicates facilities.content and must not appear twice
    expect(b).not.toContain('Innenausstattung:')
  })

  it('includes interior when it differs from facilities.content', () => {
    const a = auctionPayload()
    a.interior = '<p>Parkettböden in allen Räumen</p>'
    const b = buildDetailInfo(a).beschreibung ?? ''
    expect(b).toContain('Innenausstattung:\nParkettböden in allen Räumen')
  })

  it('keeps latlng, attachments and basics intact', () => {
    const info = buildDetailInfo(auctionPayload())
    expect(info.latlng).toEqual([48.907211, 8.505511])
    expect(info.aktenzeichen).toBe('1 K 66/24')
    expect(info.aufgehoben).toBe(false)
    expect(info.fotoCount).toBe(1)
    expect(info.attachments.map((x) => x.kind)).toEqual(['bekanntmachung', 'foto'])
  })
})
