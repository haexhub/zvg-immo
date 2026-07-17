import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { applyDetail, type PtEventoDetail } from './detail'

function auction(): Auction {
  return {
    platform: 'pt-eleiloes',
    country: 'pt',
    region: '',
    zvgId: '191921',
    aktenzeichen: 'NP1201552026',
    amtsgericht: '',
    objekt: 'Moradia sita em Alter do Chão',
    adresse: null,
    verkehrswertEur: null,
    verkehrswertText: null,
    terminIso: null,
    terminText: null,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    beschreibung: null,
    fotoCount: 1,
    thumbnailUrl: 'https://www.e-leiloes.pt/files/x_800sm.jpg',
  }
}

function item(overrides: Partial<PtEventoDetail>): PtEventoDetail {
  return {
    descricao: null,
    observacoes: null,
    areaUtilPrivativa: null,
    areaTotal: null,
    fotos: null,
    coordenadasLAT: null,
    coordenadasLON: null,
    processoNumero: null,
    processoTribunal: null,
    ...overrides,
  }
}

describe('applyDetail', () => {
  it('joins descrição and observações into beschreibung', () => {
    const a = auction()
    applyDetail(a, item({ descricao: ' Prédio urbano … ', observacoes: 'Imóvel ocupado.' }))
    expect(a.beschreibung).toBe('Prédio urbano …\n\nImóvel ocupado.')
  })

  it('maps areaUtilPrivativa to the living area for built units', () => {
    const a = auction()
    applyDetail(a, item({ areaUtilPrivativa: 130.5, areaTotal: 162 }))
    expect(a.sourceLivingAreaSqm).toBe(130.5)
    expect(a.sourceLandAreaSqm).toBeUndefined()
  })

  it('maps areaTotal to the land area for pure land lots (Rústico)', () => {
    const a = auction()
    applyDetail(a, item({ areaUtilPrivativa: 0, areaTotal: 3750 }))
    expect(a.sourceLivingAreaSqm).toBeUndefined()
    expect(a.sourceLandAreaSqm).toBe(3750)
  })

  it('collects the full gallery as absolute photo urls and updates fotoCount', () => {
    const a = auction()
    applyDetail(
      a,
      item({
        fotos: [
          { image: 'files/Verbas_Fotos/verba_110927/a_800.jpg' },
          { image: 'files/Verbas_Fotos/verba_110927/b_800.jpg' },
          { image: null },
        ],
      }),
    )
    expect(a.photoUrls).toEqual([
      'https://www.e-leiloes.pt/files/Verbas_Fotos/verba_110927/a_800.jpg',
      'https://www.e-leiloes.pt/files/Verbas_Fotos/verba_110927/b_800.jpg',
    ])
    expect(a.fotoCount).toBe(2)
  })

  it('parses the string-typed coordinates', () => {
    const a = auction()
    applyDetail(a, item({ coordenadasLAT: '39.19624975', coordenadasLON: '-7.65550532' }))
    expect(a.lat).toBeCloseTo(39.19625, 5)
    expect(a.lng).toBeCloseTo(-7.6555, 4)
  })

  it('leaves the auction untouched on an empty detail payload', () => {
    const a = auction()
    applyDetail(a, item({ coordenadasLAT: '0', coordenadasLON: '0' }))
    expect(a.beschreibung).toBeNull()
    expect(a.fotoCount).toBe(1)
    expect(a.lat).toBeUndefined()
    expect(a.photoUrls).toBeUndefined()
    expect(a.aktenzeichen).toBe('NP1201552026')
    expect(a.amtsgericht).toBe('')
  })

  it('replaces the referencia placeholder with the real case number/court', () => {
    const a = auction()
    applyDetail(a, item({ processoNumero: '1201/11.1TBCTB', processoTribunal: 'C.Branco - JC Cível - Juiz 2' }))
    expect(a.aktenzeichen).toBe('1201/11.1TBCTB')
    expect(a.amtsgericht).toBe('C.Branco - JC Cível - Juiz 2')
  })
})
