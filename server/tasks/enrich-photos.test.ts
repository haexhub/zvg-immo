import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { downloadNativeImages } from '../utils/extract/native-images'
import { archivePhotoBlob } from '../utils/raw-archive'
import { processEnrichPhotos } from './enrich-photos'

vi.mock('../utils/extract/native-images', () => ({ downloadNativeImages: vi.fn() }))
vi.mock('../utils/extract/document-images', () => ({ extractDocumentPhotos: vi.fn() }))
vi.mock('../utils/image-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/image-storage')>(),
  imagesBucketConfigured: vi.fn(() => false),
  uploadImage: vi.fn(),
}))
vi.mock('../utils/raw-archive', () => ({ archivePhotoBlob: vi.fn() }))

afterEach(() => vi.clearAllMocks())

const listing = {
  platform: 'test-platform',
  country: 'de',
  region: 'Berlin',
  externalId: '42',
  attachments: [],
  photoUrls: ['https://example.test/front.gif'],
} as unknown as Auction

const ctx = {
  at: '2026-10-01T10:00:00.000Z',
  scopedForce: false,
  needsPhotoBackfill: () => true,
  nativePhotoUrls: (a: Auction) => a.photoUrls ?? [],
  targetPhotoPipelineVersion: () => 4,
}

describe('processEnrichPhotos', () => {
  it('reports a downloaded file of unknown image type instead of archiving it as an image', async () => {
    vi.mocked(downloadNativeImages).mockResolvedValue(['front.gif'])

    const outcome = await processEnrichPhotos(listing, undefined, undefined, {
      platform: 'test-platform', country: 'de', region: 'Berlin', externalId: '42', caseNumber: null, authority: null,
    }, ctx)

    expect(archivePhotoBlob).not.toHaveBeenCalled()
    expect(outcome.error).toContain('unbekannter Bildtyp: front.gif')
    expect(outcome.photoState).toMatchObject({ photoFailures: 1, photosCheckedAt: null, photoAttempted: true })
  })
})
