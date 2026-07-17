import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEndpoint, parseData, type CzAuction } from './list'

vi.mock('~/server/utils/exchange-rate', () => ({
  getRates: vi.fn(async () => ({ CZK: 25 })),
  toEur: (amount: number, currency: string, rates: Record<string, number>) =>
    Math.round(amount / (rates[currency] ?? 1)),
}))

const RATES = { CZK: 25 }

function makeCzAuction(overrides: Partial<CzAuction> = {}): CzAuction {
  return {
    hash: 'JkW5K',
    number: '233DD84/02-1',
    voluntary: false,
    enabled: true,
    status: 'bidding',
    start_at: '2026-07-20T08:00:00.000+00:00',
    updated_at: '2026-07-03T13:13:50.105+00:00',
    estimated_price: 1762800,
    location_district: { district_name: 'Strakonice' },
    link: 'https://www.portaldrazeb.cz/drazba/233dd84-02-1-jkw5k',
    item: {
      title: 'Dražba rodinného domu',
      category: { type: 'real' },
      location_coords: { latitude: 49.4364394, longitude: 13.8669161 },
      ruian: null,
    },
    auctioneer_office: { title: 'Vlášek Václav Mgr.', district: 'Písek' },
    images: [],
    documents: [],
    ...overrides,
  }
}

function parseOne(overrides: Partial<CzAuction> = {}) {
  const auctions = parseData({ '0': makeCzAuction(overrides), '@count': 1 } as never, 'cz-portaldrazeb', RATES)
  expect(auctions).toHaveLength(1)
  return auctions[0]!
}

describe('parseData', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds photoUrls sorted by priority from the images object map', () => {
    const a = parseOne({
      images: {
        '1187l': { pathname: '/auctions/JkW5K/e88b.jpeg', hash: '1187l', priority: 1 },
        '7vxdb': { pathname: '/auctions/JkW5K/8ab9.jpeg', hash: '7vxdb', priority: 0 },
        WlD8l: { pathname: '/auctions/JkW5K/de37.jpeg', hash: 'WlD8l', priority: 2 },
      },
    })
    expect(a.photoUrls).toEqual([
      'https://www.portaldrazeb.cz/upload/auction-image/7vxdb',
      'https://www.portaldrazeb.cz/upload/auction-image/1187l',
      'https://www.portaldrazeb.cz/upload/auction-image/WlD8l',
    ])
    expect(a.fotoCount).toBe(3)
    expect(a.thumbnailUrl).toBe('https://www.portaldrazeb.cz/upload/auction-image/7vxdb')
  })

  it('handles the empty-array serialisation of images/documents', () => {
    const a = parseOne({ images: [], documents: [] })
    expect(a.photoUrls).toEqual([])
    expect(a.fotoCount).toBe(0)
    expect(a.thumbnailUrl).toBeNull()
    expect(a.attachments).toEqual([])
    expect(a.pdfUrl).toBeNull()
  })

  it('maps the documents object map to attachments and picks the decree as pdfUrl', () => {
    const a = parseOne({
      documents: {
        pe7Ad: {
          mime_type: 'application/pdf',
          size: 1400092,
          original_name: 'znalecký posudek.pdf',
          hash: 'pe7Ad',
          document_type: 'expert_report',
        },
        JlQ4p: {
          mime_type: 'application/pdf',
          size: 329297,
          original_name: 'dv1.pdf',
          hash: 'JlQ4p',
          document_type: 'auction_decree',
        },
        Nl7jp: {
          mime_type: 'application/pdf',
          size: 71197,
          original_name: 'podmínky.pdf',
          hash: 'Nl7jp',
          document_type: 'other_doc',
        },
      },
    })
    expect(a.attachments).toEqual([
      {
        kind: 'gutachten',
        label: 'znalecký posudek.pdf',
        filename: 'znalecký posudek.pdf',
        sizeBytes: 1400092,
        fileId: 'pe7Ad',
        proxyUrl: 'https://www.portaldrazeb.cz/upload/auction-document/pe7Ad',
      },
      {
        kind: 'bekanntmachung',
        label: 'dv1.pdf',
        filename: 'dv1.pdf',
        sizeBytes: 329297,
        fileId: 'JlQ4p',
        proxyUrl: 'https://www.portaldrazeb.cz/upload/auction-document/JlQ4p',
      },
      {
        kind: 'sonstiges',
        label: 'podmínky.pdf',
        filename: 'podmínky.pdf',
        sizeBytes: 71197,
        fileId: 'Nl7jp',
        proxyUrl: 'https://www.portaldrazeb.cz/upload/auction-document/Nl7jp',
      },
    ])
    expect(a.pdfUrl).toBe('https://www.portaldrazeb.cz/upload/auction-document/JlQ4p')
    expect(a.pdfUrlUpstream).toBe(a.pdfUrl)
  })

  it('takes coordinates from item.location_coords', () => {
    const a = parseOne()
    expect(a.lat).toBe(49.4364394)
    expect(a.lng).toBe(13.8669161)
  })

  it('falls back to item.ruian.coords for coordinates and builds the address from RUIAN', () => {
    const a = parseOne({
      item: {
        title: 'Dražba rodinného domu',
        category: { type: 'real' },
        location_coords: null,
        ruian: {
          city_name: 'Přerov',
          street_name: 'Zámecká',
          house_number: '230',
          street_number: '31',
          coords: { latitude: 49.4899232, longitude: 17.426161 },
        },
      },
    })
    expect(a.lat).toBe(49.4899232)
    expect(a.lng).toBe(17.426161)
    expect(a.adresse).toBe('Zámecká 230/31, Přerov, Tschechien')
  })

  it('builds a village address without street name and keeps the district fallback otherwise', () => {
    const village = parseOne({
      item: {
        title: 'Dražba domu',
        category: { type: 'real' },
        ruian: { city_name: 'Jestřebí', street_name: null, house_number: '72', street_number: null },
      },
    })
    expect(village.adresse).toBe('Jestřebí 72, Tschechien')

    const bare = parseOne()
    expect(bare.adresse).toBe('Strakonice, Tschechien')
    expect(bare.lat).toBe(49.4364394)
  })

  it('converts the CZK estimate to EUR', () => {
    const a = parseOne()
    expect(a.verkehrswertEur).toBe(70512)
    expect(a.verkehrswertText).toBe('1.762.800 Kč')
  })

  it('skips voluntary and non-real auctions', () => {
    const auctions = parseData(
      {
        '0': makeCzAuction({ voluntary: true }),
        '1': makeCzAuction({ hash: 'mjn8e', item: { title: 'Auto', category: { type: 'movable' } } }),
      },
      'cz-portaldrazeb',
      RATES,
    )
    expect(auctions).toEqual([])
  })

  it('throws when every paginated fetch is full up to the safety cap', async () => {
    const fullPage = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [String(i), { hash: `h${i}` }]),
    )
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify(fullPage), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return {
        ok: true,
        text: async (): Promise<string> => '<html><meta name="csrf-token" content="csrf"></html>',
        headers: { getSetCookie: () => ['PHPSESSID=abc; path=/'] },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchEndpoint('/drazby/pripravovane.json', 'cz-portaldrazeb')).rejects.toThrow(
      /safety cap/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(21)
  })
})
