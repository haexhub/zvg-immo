import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

const DETAIL_FIXTURE = JSON.stringify({
  items: [{ identifier: '10135.3515.768.3.49' }],
  attachments: [
    {
      id: 16374,
      fileName: 'Ap. 47 pic_page-0001.jpg',
      blob: { fileType: '.jpg', href: 'https://zapori.mjs.bg/api/blobs/16374?t=1&h=abc' },
    },
    {
      id: 16375,
      fileName: 'Ap. 47 pic_page-0002.jpg',
      blob: { fileType: '.jpg', href: 'https://zapori.mjs.bg/api/blobs/16375?t=1&h=def' },
    },
    {
      id: 16376,
      fileName: '57-26 обявление електронен търг.pdf',
      blob: { fileType: '.pdf', href: 'https://zapori.mjs.bg/api/blobs/16376?t=1&h=ghi' },
    },
  ],
})

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'bg-zapori',
    country: 'bg',
    region: '',
    externalId: '3505',
    caseNumber: '20267130400057',
    authority: 'Люба Тодорова',
    title: 'ПОЗЕМЛЕН ИМОТ',
    address: null,
    marketValueEur: 136000,
    marketValueText: '136.000 €',
    auctionDateIso: '2026-09-17T06:00:00Z',
    auctionDateText: '17.09.2026, 09:00 Uhr',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://zapori.mjs.bg/#/announcements/display/3505',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://zapori.mjs.bg/#/announcements/display/3505',
    attachments: [],
    description: 'АПАРТАМЕНТ №47.',
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

// archiveDetailCapture (called from enrichOne) goes through getPool(), which
// reads useRuntimeConfig().databaseUrl — undefined here, so it safely no-ops.
beforeEach(() => vi.stubGlobal('useRuntimeConfig', () => ({})))
afterEach(() => vi.unstubAllGlobals())

describe('enrichOne', () => {
  it('splits photos from the PDF notice and appends the cadastral identifier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_FIXTURE)))
    const a = makeAuction()
    await enrichOne(a)

    expect(a.photoUrls).toEqual([
      'https://zapori.mjs.bg/api/blobs/16374?t=1&h=abc',
      'https://zapori.mjs.bg/api/blobs/16375?t=1&h=def',
    ])
    expect(a.photoCount).toBe(2)
    expect(a.thumbnailUrl).toBe('https://zapori.mjs.bg/api/blobs/16374?t=1&h=abc')

    expect(a.attachments).toHaveLength(1)
    expect(a.attachments[0]).toMatchObject({
      kind: 'announcement',
      filename: '57-26 обявление електронен търг.pdf',
      proxyUrl: 'https://zapori.mjs.bg/api/blobs/16376?t=1&h=ghi',
    })

    expect(a.description).toBe('АПАРТАМЕНТ №47.\n\nИдентификатор: 10135.3515.768.3.49')
  })

  it('does not duplicate the identifier line on a repeated enrich run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_FIXTURE)))
    const a = makeAuction({ description: 'АПАРТАМЕНТ №47.\n\nИдентификатор: 10135.3515.768.3.49' })
    await enrichOne(a)
    expect(a.description).toBe('АПАРТАМЕНТ №47.\n\nИдентификатор: 10135.3515.768.3.49')
  })

  it('leaves photos/attachments untouched when the detail has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: null, attachments: null }))),
    )
    const a = makeAuction()
    await enrichOne(a)
    expect(a.photoCount).toBe(0)
    expect(a.attachments).toEqual([])
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('502')
  })
})
