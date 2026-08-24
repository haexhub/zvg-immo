import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { redactAffectedPersonNames, redactAuctionForPublication } from './public-auction-redaction'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Hessen',
    externalId: '42',
    caseNumber: '1 K 2/26',
    authority: 'AG Test',
    title: 'Landwirtschaftliche Fläche',
    address: 'Musterweg 1, Beispielstadt',
    marketValueEur: 47_000,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: 'https://local.test/bekanntmachung.pdf',
    detailUrl: 'https://local.test/detail',
    pdfUrlUpstream: 'https://source.test/bekanntmachung.pdf',
    detailUrlUpstream: 'https://source.test/detail',
    attachments: [{ kind: 'appraisal', label: 'Gutachten', proxyUrl: 'https://local.test/gutachten.pdf' }],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

describe('redactAffectedPersonNames', () => {
  it('keeps the legal fact but removes a co-owner name', () => {
    const text = 'Ein Insolvenzverfahren über den Miteigentümer Max Mustermann wurde eröffnet.'
    expect(redactAffectedPersonNames(text)).toBe(
      'Ein Insolvenzverfahren über den Miteigentümer [anonymisiert] wurde eröffnet.',
    )
  })

  it('redacts explicitly labelled debtors', () => {
    expect(redactAffectedPersonNames('Schuldnerin: Erika Musterfrau\nTermin: 10:00 Uhr')).toBe(
      'Schuldnerin: [anonymisiert]\nTermin: 10:00 Uhr',
    )
  })

  it('does not alter ordinary property or place names', () => {
    expect(redactAffectedPersonNames('Einfamilienhaus in Bad Neustadt am Main')).toBe(
      'Einfamilienhaus in Bad Neustadt am Main',
    )
  })
})

describe('redactAuctionForPublication', () => {
  it('redacts all display text while retaining linked source documents', () => {
    const result = redactAuctionForPublication(auction({
      extraction: {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'llm',
        confidence: 'high',
        at: '2026-08-24T00:00:00.000Z',
        documentSummary: 'Das Insolvenzverfahren über den Miteigentümer Max Mustermann ist eröffnet.',
        insights: {
          defects: [],
          encumbrances: ['Schuldner: Erika Musterfrau'],
          landValueEurPerSqm: null,
          construction: null,
          locationCharacter: null,
          summary: null,
        },
      },
    }))

    expect(result.redacted).toBe(true)
    expect(result.auction.extraction?.documentSummary).not.toContain('Max Mustermann')
    expect(result.auction.extraction?.insights?.encumbrances[0]).toBe('Schuldner: [anonymisiert]')
    expect(result.auction.attachments).toHaveLength(1)
    expect(result.auction.pdfUrl).toBe('https://local.test/bekanntmachung.pdf')
    expect(result.auction.pdfUrlUpstream).toBe('https://source.test/bekanntmachung.pdf')
    expect(result.auction.detailUrl).toBe('https://local.test/detail')
    expect(result.auction.detailUrlUpstream).toBe('https://source.test/detail')
  })
})
