import { describe, expect, it } from 'vitest'
import { buildPageUrl, extractBusquedaToken, PAGE_HITS } from './list'
import { applyDetail } from './index'
import type { DetailInfo } from './detail'

const TOKEN = '_TXI3TThyNm0zNVZGbkFabkJ6bW0xNlM0Rmp0SFJjZVJDbWgvKzBHcDhGa3JsYThOMUhQeU5FYkJB,,'

describe('extractBusquedaToken', () => {
  it('reads the token from a pagination link', () => {
    const html = `<a href="subastas_ava.php?accion=Mas&amp;id_busqueda=${TOKEN}-500-500">Pág. siguiente</a>`
    expect(extractBusquedaToken(html)).toBe(TOKEN)
  })

  it('falls back to the idBus param on detail links', () => {
    const html = `<a href="./detalleSubasta.php?idSub=SUB-JA-2022-197725&amp;ver=1&amp;idBus=${TOKEN}&amp;idLote=1">detalle</a>`
    expect(extractBusquedaToken(html)).toBe(TOKEN)
  })

  it('returns null when no token is present', () => {
    expect(extractBusquedaToken('<html><body>captcha</body></html>')).toBeNull()
  })
})

describe('buildPageUrl', () => {
  it('addresses the follow-up page via accion=Mas and the offset suffix', () => {
    expect(buildPageUrl(TOKEN, 500)).toBe(
      `https://subastas.boe.es/subastas_ava.php?accion=Mas&id_busqueda=${TOKEN}-500-${PAGE_HITS}`,
    )
  })
})

function info(overrides: Partial<DetailInfo>): DetailInfo {
  return {
    tasacionEur: null,
    tasacionText: null,
    valorSubastaText: null,
    anuncioBoeId: null,
    description: null,
    referenciaCatastral: null,
    address: null,
    ...overrides,
  }
}

function auctionFields() {
  return {
    marketValueEur: null,
    marketValueText: null,
    description: null,
    address: null,
    pdfUrl: null,
    pdfUrlUpstream: null,
    startingBid: null,
  }
}

describe('applyDetail', () => {
  it('appends valor subasta and referencia catastral as labelled lines', () => {
    const auction = auctionFields()
    applyDetail(
      auction,
      info({
        description: 'Vivienda en Madrid',
        valorSubastaText: '117.000,00 €',
        referenciaCatastral: '9872023VH5797S0001WX',
      }),
    )
    expect(auction.description).toBe(
      'Vivienda en Madrid\nValor subasta: 117.000,00 €\nReferencia catastral: 9872023VH5797S0001WX',
    )
  })

  it('keeps the labelled lines even without a descripción', () => {
    const auction = auctionFields()
    applyDetail(auction, info({ valorSubastaText: '50.000,00 €' }))
    expect(auction.description).toBe('Valor subasta: 50.000,00 €')
  })

  it('leaves description untouched when the detail tabs held nothing', () => {
    const auction = { ...auctionFields(), description: 'aus dem Listing' }
    applyDetail(auction, info({}))
    expect(auction.description).toBe('aus dem Listing')
  })

  it('parses valor subasta into startingBid', () => {
    const auction = auctionFields()
    applyDetail(auction, info({ valorSubastaText: '45.000,00 €' }))
    expect(auction.startingBid).toBe(45000)
  })

  it('sets startingBid to null when no valor subasta is present', () => {
    const auction = auctionFields()
    applyDetail(auction, info({}))
    expect(auction.startingBid).toBeNull()
  })
})
