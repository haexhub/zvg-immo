import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { applyDetail, type PtEventoDetail } from './detail'

function auction(): Auction {
  return {
    platform: 'pt-eleiloes',
    country: 'pt',
    region: '',
    externalId: '191921',
    caseNumber: 'NP1201552026',
    authority: '',
    title: 'Moradia sita em Alter do Chão',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 1,
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
  it('joins descrição and observações into description', () => {
    const a = auction()
    applyDetail(a, item({ descricao: ' Prédio urbano … ', observacoes: 'Imóvel ocupado.' }))
    expect(a.description).toBe('Prédio urbano …\n\nImóvel ocupado.')
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

  it('collects the full gallery as absolute photo urls and updates photoCount', () => {
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
    expect(a.photoCount).toBe(2)
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
    expect(a.description).toBeNull()
    expect(a.photoCount).toBe(1)
    expect(a.lat).toBeUndefined()
    expect(a.photoUrls).toBeUndefined()
    expect(a.caseNumber).toBe('NP1201552026')
    expect(a.authority).toBe('')
  })

  it('replaces the referencia placeholder with the real case number/court', () => {
    const a = auction()
    applyDetail(a, item({ processoNumero: '1201/11.1TBCTB', processoTribunal: 'C.Branco - JC Cível - Juiz 2' }))
    expect(a.caseNumber).toBe('1201/11.1TBCTB')
    expect(a.authority).toBe('C.Branco - JC Cível - Juiz 2')
  })
})
