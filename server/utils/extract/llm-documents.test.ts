import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Auction } from '~/types/auction'
import { downloadBlob, findLatestCapture, readDocumentSetItems } from '../storage-download'
import { markdownForPdf } from './docling'

vi.mock('../storage-download', () => ({
  downloadBlob: vi.fn(),
  findLatestCapture: vi.fn(),
  readDocumentSetItems: vi.fn(),
}))
// archiveDocumentBlob/archiveDocumentText hit Postgres via getPool(), which
// calls the Nuxt-only useRuntimeConfig() — unavailable in this plain vitest
// environment. prepareLiveLlmDocuments's tests below only care about the
// live-fetch outcome, not the archiving step past it.
vi.mock('../raw-archive', () => ({
  archiveDocumentBlob: vi.fn(async () => 'stub-hash'),
  archiveDocumentText: vi.fn(async () => undefined),
}))
vi.mock('./pdf-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdf-text')>()
  return { ...actual, extractPdfTextFromBuffer: vi.fn(async () => 'PDF Wohnfläche 140 m²') }
})
// Docling is off unless a test stubs useRuntimeConfig().doclingUrl; the client
// itself is covered by docling.test.ts, here only its effect on the prepared
// input matters.
vi.mock('./docling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./docling')>()
  return { ...actual, markdownForPdf: vi.fn(async () => null) }
})
vi.mock('./pdf-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdf-render')>()
  return { ...actual, renderPdfPagesJpeg: vi.fn(async () => []) }
})

const { htmlToText, pickAllLlmDocumentAttachments, prepareArchivedLlmDocuments, prepareLiveLlmDocuments } = await import('./llm-documents')

function att(overrides: Partial<Attachment>): Attachment {
  return {
    kind: 'other',
    label: '',
    filename: '',
    sizeBytes: null,
    fileId: '',
    proxyUrl: '',
    ...overrides,
  }
}

function auction(attachments: Attachment[] = []): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '1',
    caseNumber: '12 K 1/26',
    authority: 'AG Test',
    title: 'Wohnhaus',
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
    attachments,
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

function writeUInt16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function writeUInt32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function zipWithDocumentXml(xml: string): Buffer {
  const name = Buffer.from('word/document.xml')
  const body = Buffer.from(xml)
  const compressed = deflateRawSync(body)
  const localHeader = Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    name,
  ])
  const local = Buffer.concat([localHeader, compressed])
  const central = Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16(20),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(0),
    name,
  ])
  const eocd = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(1),
    writeUInt16(1),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ])
  return Buffer.concat([local, central, eocd])
}

beforeEach(() => {
  vi.mocked(findLatestCapture).mockResolvedValue(null)
  vi.mocked(readDocumentSetItems).mockResolvedValue([])
  vi.mocked(downloadBlob).mockResolvedValue(null)
})

describe('pickAllLlmDocumentAttachments', () => {
  it('keeps every attachment kind, including photos and other documents, with stable priority ordering', () => {
    const picked = pickAllLlmDocumentAttachments([
      att({ kind: 'other', filename: 'terms.txt', proxyUrl: 'https://example.test/terms.txt' }),
      att({ kind: 'photo', filename: 'scan.jpg', proxyUrl: 'https://example.test/scan.jpg' }),
      att({ kind: 'appraisal', filename: 'gutachten.pdf', proxyUrl: 'https://example.test/gutachten.pdf' }),
      att({ kind: 'brochure', filename: 'expose.html', proxyUrl: 'https://example.test/expose.html' }),
      att({ kind: 'other', filename: 'dupe.txt', proxyUrl: 'https://example.test/terms.txt' }),
    ])

    expect(picked.map((item) => item.filename)).toEqual([
      'gutachten.pdf',
      'expose.html',
      'scan.jpg',
      'terms.txt',
    ])
  })
})

describe('htmlToText', () => {
  it('strips scripts/styles/tags and decodes common entities', () => {
    expect(
      htmlToText('<html><style>.x{}</style><script>alert(1)</script><body><h1>Wohnhaus</h1><p>140&nbsp;m&sup2; &amp; Garage</p></body></html>'),
    ).toContain('Wohnhaus\n140 m&sup2; & Garage')
  })
})

describe('prepareArchivedLlmDocuments', () => {
  it('detects PDF, DOCX, HTML, text and image bytes from the archived document set', async () => {
    const attachments = [
      att({ kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', proxyUrl: 'https://example.test/gutachten.pdf' }),
      att({ kind: 'brochure', label: 'Expose', filename: 'expose.docx', proxyUrl: 'https://example.test/expose.docx' }),
      att({ kind: 'announcement', label: 'HTML', filename: 'notice.html', proxyUrl: 'https://example.test/notice.html' }),
      att({ kind: 'other', label: 'Text', filename: 'notes.txt', proxyUrl: 'https://example.test/notes.txt' }),
      att({ kind: 'other', label: 'Scan', filename: 'scan.jpg', proxyUrl: 'https://example.test/scan.jpg' }),
      att({ kind: 'photo', label: 'Gallery', filename: 'gallery.jpg', proxyUrl: 'https://example.test/gallery.jpg' }),
    ]
    vi.mocked(readDocumentSetItems).mockResolvedValue([
      { ordinal: 0, kind: 'document', label: 'Gutachten', filename: 'gutachten.pdf', fileId: '1', sourceUrl: attachments[0]!.proxyUrl, contentHash: 'pdf', contentType: 'application/pdf' },
      { ordinal: 1, kind: 'document', label: 'Expose', filename: 'expose.docx', fileId: '2', sourceUrl: attachments[1]!.proxyUrl, contentHash: 'docx', contentType: 'application/vnd.docx' },
      { ordinal: 2, kind: 'document', label: 'HTML', filename: 'notice.html', fileId: '3', sourceUrl: attachments[2]!.proxyUrl, contentHash: 'html', contentType: 'text/html' },
      { ordinal: 3, kind: 'document', label: 'Text', filename: 'notes.txt', fileId: '4', sourceUrl: attachments[3]!.proxyUrl, contentHash: 'text', contentType: 'text/plain' },
      { ordinal: 4, kind: 'document', label: 'Scan', filename: 'scan.jpg', fileId: '5', sourceUrl: attachments[4]!.proxyUrl, contentHash: 'scan', contentType: 'image/jpeg' },
      { ordinal: 5, kind: 'document', label: 'Gallery', filename: 'gallery.jpg', fileId: '6', sourceUrl: attachments[5]!.proxyUrl, contentHash: 'gallery', contentType: 'image/jpeg' },
    ])
    vi.mocked(downloadBlob).mockImplementation(async (hash) => {
      if (hash === 'pdf') return Buffer.from('%PDF-1.4\n%%EOF')
      if (hash === 'docx') {
        return zipWithDocumentXml('<w:document><w:body><w:p><w:r><w:t>DOCX Baujahr 1999</w:t></w:r></w:p></w:body></w:document>')
      }
      if (hash === 'html') return Buffer.from('<html><body><p>HTML Grundstück 700 m²</p></body></html>')
      if (hash === 'text') return Buffer.from('Text Energieausweis vorhanden')
      if (hash === 'scan' || hash === 'gallery') return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9])
      return null
    })

    const prepared = await prepareArchivedLlmDocuments(auction(attachments), { nativeDocuments: false })

    expect(prepared.input.pdfText).toContain('PDF Wohnfläche 140 m²')
    expect(prepared.input.documentText).not.toContain('PDF Wohnfläche 140 m²')
    expect(prepared.input.documentText).toContain('DOCX Baujahr 1999')
    expect(prepared.input.documentText).toContain('HTML Grundstück 700 m²')
    expect(prepared.input.documentText).toContain('Text Energieausweis vorhanden')
    expect(prepared.input.documentImages).toEqual([
      { label: 'Scan', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]).toString('base64') },
    ])
  })

  it('caps combined documentText across all archived text sections', async () => {
    vi.mocked(readDocumentSetItems).mockResolvedValue([
      { ordinal: 0, kind: 'document', label: 'Long 1', filename: 'one.txt', fileId: '1', sourceUrl: 'https://example.test/one.txt', contentHash: 'one', contentType: 'text/plain' },
      { ordinal: 1, kind: 'document', label: 'Long 2', filename: 'two.txt', fileId: '2', sourceUrl: 'https://example.test/two.txt', contentHash: 'two', contentType: 'text/plain' },
      { ordinal: 2, kind: 'document', label: 'Long 3', filename: 'three.txt', fileId: '3', sourceUrl: 'https://example.test/three.txt', contentHash: 'three', contentType: 'text/plain' },
    ])
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from('x'.repeat(40_000)))

    const prepared = await prepareArchivedLlmDocuments(auction(), { nativeDocuments: false })

    expect(prepared.input.documentText?.length).toBeLessThanOrEqual(80_000)
  })

  describe('with Docling configured', () => {
    beforeEach(() => {
      vi.mocked(markdownForPdf).mockReset()
      vi.stubGlobal('useRuntimeConfig', () => ({ doclingUrl: 'http://docling:5001' }))
    })

    it('sends converted Markdown as text instead of the raw PDF bytes', async () => {
      vi.mocked(markdownForPdf).mockResolvedValue('## Flurstücke\n\n| Gemarkung | m² |\n|---|---|\n| Ebingen | 1.112 |')
      vi.mocked(readDocumentSetItems).mockResolvedValue([
        { ordinal: 0, kind: 'document', label: 'Gutachten', filename: 'g.pdf', fileId: '1', sourceUrl: 'https://example.test/g.pdf', contentHash: 'pdf', contentType: 'application/pdf' },
      ])
      vi.mocked(downloadBlob).mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF'))

      // nativeDocuments: true is the live prod setting (gemini-native).
      const prepared = await prepareArchivedLlmDocuments(auction(), { nativeDocuments: true })

      expect(prepared.input.pdfText).toContain('| Gemarkung | m² |')
      expect(prepared.input.pdfBytes).toBeNull()
      expect(prepared.input.pdfDocuments).toBeUndefined()
    })

    // The regression this guards: a set where Docling handled some documents
    // and not others must reach the model complete, not lose the converted
    // half because native bytes are present.
    it('keeps both converted text and native bytes in a mixed set', async () => {
      vi.mocked(markdownForPdf).mockImplementation(async (_db, hash) =>
        hash === 'converted' ? '## Konvertiert' : null)
      vi.mocked(readDocumentSetItems).mockResolvedValue([
        { ordinal: 0, kind: 'document', label: 'Gutachten', filename: 'a.pdf', fileId: '1', sourceUrl: 'https://example.test/a.pdf', contentHash: 'converted', contentType: 'application/pdf' },
        { ordinal: 1, kind: 'document', label: 'Bekanntmachung', filename: 'b.pdf', fileId: '2', sourceUrl: 'https://example.test/b.pdf', contentHash: 'failed', contentType: 'application/pdf' },
      ])
      vi.mocked(downloadBlob).mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF'))

      const prepared = await prepareArchivedLlmDocuments(auction(), { nativeDocuments: true })

      expect(prepared.input.pdfText).toContain('## Konvertiert')
      expect(prepared.input.pdfBytes).toBe(Buffer.from('%PDF-1.4\n%%EOF').toString('base64'))
    })

    it('falls back to pdftotext when a conversion fails and the provider is not native', async () => {
      vi.mocked(markdownForPdf).mockResolvedValue(null)
      vi.mocked(readDocumentSetItems).mockResolvedValue([
        { ordinal: 0, kind: 'document', label: 'Gutachten', filename: 'g.pdf', fileId: '1', sourceUrl: 'https://example.test/g.pdf', contentHash: 'pdf', contentType: 'application/pdf' },
      ])
      vi.mocked(downloadBlob).mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF'))

      const prepared = await prepareArchivedLlmDocuments(auction(), { nativeDocuments: false })

      expect(prepared.input.pdfText).toContain('PDF Wohnfläche 140 m²')
    })
  })
})

describe('prepareLiveLlmDocuments', () => {
  const identity = { platform: 'se-kronofogden', country: 'se', region: 'Schweden', externalId: '101746', caseNumber: null, authority: 'Kronofogden' }

  it('reports the real fetch failure reason instead of swallowing it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))

    const attachments: Attachment[] = [
      att({ kind: 'appraisal', label: 'Beskrivning och värdering', filename: 'F-2209-25.pdf', proxyUrl: 'https://auktionstorget.kronofogden.se/download/F-2209-25.pdf' }),
    ]

    const result = await prepareLiveLlmDocuments(attachments, identity, '2026-07-31T08:27:35.000Z')

    expect(result.documentSetComplete).toBe(false)
    expect(result.documentSetItems).toEqual([])
    expect(result.errors).toEqual(['Beskrivning och värdering: HTTP 403'])

    vi.unstubAllGlobals()
  })

  it('leaves errors undefined once every candidate fetch succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))

    const attachments: Attachment[] = [
      att({ kind: 'appraisal', label: 'Beskrivning och värdering', filename: 'F-2209-25.pdf', proxyUrl: 'https://auktionstorget.kronofogden.se/download/F-2209-25.pdf' }),
    ]

    const result = await prepareLiveLlmDocuments(attachments, identity, '2026-07-31T08:27:35.000Z')

    expect(result.documentSetComplete).toBe(true)
    expect(result.errors).toBeUndefined()

    vi.unstubAllGlobals()
  })
})
