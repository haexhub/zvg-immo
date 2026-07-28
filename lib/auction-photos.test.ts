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
  it('combines the native gallery with locally extracted document photos', () => {
    expect(
      auctionPhotoUrls(
        auction({
          photoUrls: ['https://zvg.test/1.jpg', 'https://zvg.test/2.jpg'],
          extraction: {
            propertyType: null,
            landAreaSqm: null,
            livingAreaSqm: null,
            rooms: null,
            units: null,
            source: 'rules',
            confidence: 'low',
            photos: [{ file: 'page 1.jpg', category: 'aussen', caption: null, isPropertyPhoto: true }],
            at: '2026-07-25T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual([
      'https://zvg.test/1.jpg',
      'https://zvg.test/2.jpg',
      '/api/auction-image/mv-zvgcom/210678/page%201.jpg',
    ])
  })

  it('uses the thumbnail only when no full-size image is available', () => {
    expect(auctionPhotoUrls(auction({ thumbnailUrl: '/thumb.jpg' }))).toEqual(['/thumb.jpg'])
    expect(
      auctionPhotoUrls(
        auction({ thumbnailUrl: '/thumb.jpg', photoUrls: ['/full.jpg'] }),
      ),
    ).toEqual(['/full.jpg'])
  })

  it('deduplicates identical URLs', () => {
    expect(
      auctionPhotoUrls(
        auction({
          photoUrls: ['/same.jpg'],
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
    ).toEqual(['/same.jpg'])
  })

  it('does not infer native-gallery coverage from hash-like local document filenames', () => {
    expect(
      auctionPhotoUrls(
        auction({
          photoUrls: ['https://zvg.test/1.jpg', 'https://zvg.test/2.jpg'],
          extraction: {
            propertyType: null,
            landAreaSqm: null,
            livingAreaSqm: null,
            rooms: null,
            units: null,
            source: 'rules',
            confidence: 'low',
            photos: [
              { file: '1111111111111111.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
              { file: '2222222222222222.jpg', category: 'innen', caption: null, isPropertyPhoto: true },
            ],
            photosCheckedAt: '2026-07-25T00:00:00.000Z',
            at: '2026-07-25T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual([
      'https://zvg.test/1.jpg',
      'https://zvg.test/2.jpg',
      '/api/auction-image/mv-zvgcom/210678/1111111111111111.jpg',
      '/api/auction-image/mv-zvgcom/210678/2222222222222222.jpg',
    ])
  })
})
