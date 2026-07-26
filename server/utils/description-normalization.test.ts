import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { createCrawlResult } from '~/server/crawlers/types'
import { normalizeAuctionDescription, normalizeDescriptionText } from './description-normalization'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'all',
    externalId: '1',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: null,
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
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

describe('normalizeDescriptionText', () => {
  it('strips executable HTML and keeps readable paragraphs', () => {
    expect(normalizeDescriptionText(`
      <p>Wohnhaus &amp; Nebengebäude</p>
      <script>window.AppRegistry.registerInitialState('x', {"large": true});</script>
      <p>Grundstück 500 m²</p>
    `)).toBe('Wohnhaus & Nebengebäude\n\nGrundstück 500 m²')
  })

  it('strips unclosed executable HTML blocks through the end of input', () => {
    for (const tag of ['script', 'style', 'noscript', 'template']) {
      expect(normalizeDescriptionText(`Visible<${tag}>discarded`)).toBe('Visible')
    }
  })

  it('drops numeric entities outside the Unicode scalar range', () => {
    expect(normalizeDescriptionText('A &#65; &#x41; &#x110000; &#1114112; &#xD800; B')).toBe('A A A B')
  })

  it('removes leaked hydration/app state from already-stripped text', () => {
    const text = [
      'Anmeldung offen bis 10:00AppRegistry.registerBootstrapData("x","y","AGNOSTIC_RENDERER");',
      'AppRegistry.registerApp({applicationId:"auk-visning-app",requiredLibs:{"react":"17.0.2"}});',
    ].join('\n')

    expect(normalizeDescriptionText(text)).toBe('Anmeldung offen bis 10:00')
  })

  it('drops technical monster lines without deleting normal long prose', () => {
    const technical = `{"isActive":true,"showingAddress":"Test","requiredLibs":{"react":"17.0.2"},"payload":"${'x'.repeat(600)}"}`
    const prose = 'Dieses Objekt liegt in ruhiger Lage und umfasst ein Wohnhaus mit Garten.'

    expect(normalizeDescriptionText(`${prose}\n${technical}`)).toBe(prose)
  })

  it('returns null for empty descriptions after cleanup', () => {
    expect(normalizeDescriptionText('<script>AppRegistry.registerApp({})</script>')).toBeNull()
  })
})

describe('normalizeAuctionDescription', () => {
  it('mutates the auction description in place', () => {
    const a = auction({ description: '<p>Text</p><script>bad()</script>' })
    normalizeAuctionDescription(a)
    expect(a.description).toBe('Text')
  })
})

describe('createCrawlResult description normalization', () => {
  it('normalizes every crawler result centrally', () => {
    const a = auction({ description: '<p>List text</p><script>AppRegistry.registerApp({})</script>' })
    const result = createCrawlResult({
      platform: 'test',
      source: 'https://example.test',
      country: 'de',
      regions: [{ code: 'all', name: 'Alle' }],
      totalReported: 1,
      auctions: [a],
    })

    expect(result.auctions[0]?.description).toBe('List text')
  })
})
