import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { auctionPhotoUrls } from './auction-photos'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'mv-zvgcom',
    country: 'de',
    region: 'Mecklenburg-Vorpommern',
    externalId: '210678',
    caseNumber: '41 K 43/24',
    authority: 'Amtsgericht Greifswald',
    title: 'Gutshaus',
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

describe('auctionPhotoUrls', () => {
  it('builds the gallery from curated extraction.photos', () => {
    expect(
      auctionPhotoUrls(
        auction({
          extraction: {
            propertyType: null,
            landAreaSqm: null,
            livingAreaSqm: null,
            rooms: null,
            units: null,
            source: 'rules',
            confidence: 'low',
            photos: [
              { file: 'page 1.jpg', category: 'aussen', caption: null, isPropertyPhoto: true, appealScore: 30 },
              { file: '2222222222222222.jpg', category: 'innen', caption: null, isPropertyPhoto: true, appealScore: 90 },
            ],
            at: '2026-07-25T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual([
      '/api/auction-image/mv-zvgcom/210678/2222222222222222.jpg',
      '/api/auction-image/mv-zvgcom/210678/page%201.jpg',
    ])
  })

  it('ignores raw crawler photoUrls/proxyUrl attachments — display comes only from extraction.photos', () => {
    expect(
      auctionPhotoUrls(
        auction({
          thumbnailUrl: '/thumb.jpg',
          photoUrls: ['https://zvg.test/1.jpg', 'https://zvg.test/2.jpg'],
          attachments: [{
            kind: 'photo',
            label: 'Foto',
            filename: 'same.jpg',
            sizeBytes: null,
            fileId: '1',
            proxyUrl: '/same.jpg',
          }],
        }),
      ),
    ).toEqual(['/thumb.jpg'])
  })

  it('uses the thumbnail only when there are no curated photos', () => {
    expect(auctionPhotoUrls(auction({ thumbnailUrl: '/thumb.jpg' }))).toEqual(['/thumb.jpg'])
    expect(auctionPhotoUrls(auction())).toEqual([])
  })

  it('ignores an off-origin thumbnail instead of hotlinking the source platform', () => {
    expect(auctionPhotoUrls(auction({ thumbnailUrl: 'https://zvg.test/thumb.jpg' }))).toEqual([])
  })

  it('deduplicates identical curated photo URLs', () => {
    expect(
      auctionPhotoUrls(
        auction({
          extraction: {
            propertyType: null,
            landAreaSqm: null,
            livingAreaSqm: null,
            rooms: null,
            units: null,
            source: 'rules',
            confidence: 'low',
            photos: [
              { file: 'same.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
              { file: 'same.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
            ],
            at: '2026-07-25T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual(['/api/auction-image/mv-zvgcom/210678/same.jpg'])
  })
})
