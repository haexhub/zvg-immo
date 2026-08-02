import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { downloadBlob, findLatestCapture } from '../utils/storage-download'

vi.mock('../utils/storage-download', () => ({
  findLatestCapture: vi.fn(),
  downloadBlob: vi.fn(),
  readDocumentSetItems: vi.fn(async () => []),
}))

vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { reprocessAuction } = await import('./reprocess')

const emptyArtifactState = {
  latest: null,
  parsedArtifactVersionId: null,
}

function auction(): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Berlin',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    description: 'Wohnflaeche 120 m2, Grundstueck 500 m2.',
    photoCount: 0,
    thumbnailUrl: null,
  }
}

afterEach(() => vi.clearAllMocks())

describe('reprocessAuction structured provenance', () => {
  it('returns null when no archived auction capture exists', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue(null)

    await expect(reprocessAuction(
      'zvg-portal',
      'missing',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState },
    )).resolves.toBeNull()

    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('returns null when archived auction bytes cannot be loaded', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue({
      contentHash: 'missing-blob',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    })
    vi.mocked(downloadBlob).mockResolvedValue(null)

    await expect(reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState },
    )).resolves.toBeNull()
  })

  it('keeps the parsed artifact pointer when only rules run', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue({
      contentHash: 'auction-hash',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    })
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction())))

    const result = await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      {
        priorLlmFailures: 2,
        artifactState: {
          latest: {
            id: 22,
            platform: 'zvg-portal',
            externalId: '7265',
            version: 2,
            setHash: 'latest-hash',
          },
          parsedArtifactVersionId: 11,
        },
      },
    )

    expect(result).toMatchObject({
      llmCalled: false,
      llmFailures: 2,
      artifactVersionId: 11,
      entry: { source: 'rules', confidence: 'high' },
    })
  })
})
