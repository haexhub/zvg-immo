import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '~/types/auction'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === 'private.test') return [{ address: '127.0.0.1', family: 4 }]
    return [{ address: '93.184.216.34', family: 4 }]
  }),
}))
vi.mock('./pdf-images', () => ({ extractPdfPhotos: vi.fn(async () => ['pdf-photo.jpg']) }))

const { extractDocumentPhotos, extractHtmlImageUrls, pickDocumentImageCandidates } = await import('./document-images')
const { extractPdfPhotos } = await import('./pdf-images')

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    kind: 'other',
    label: 'Document',
    filename: 'doc.pdf',
    sizeBytes: null,
    fileId: 'doc',
    proxyUrl: 'https://example.test/doc.pdf',
    ...overrides,
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

function zip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const compressed = deflateRawSync(entry.bytes)
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(8),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(compressed.length),
      writeUInt32(entry.bytes.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ])
    const local = Buffer.concat([localHeader, compressed])
    locals.push(local)
    centrals.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(8),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(compressed.length),
      writeUInt32(entry.bytes.length),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      name,
    ]))
    offset += local.length
  }
  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(centralBytes.length),
    writeUInt32(localBytes.length),
    writeUInt16(0),
  ])
  return Buffer.concat([localBytes, centralBytes, eocd])
}

function png(width: number, height: number, byte = 1): Buffer {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
    Buffer.from('IHDR'),
    Buffer.alloc(13),
    Buffer.alloc(1024, byte),
  ])
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function stubFetch(responses: Record<string, Buffer | string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = responses[url]
      if (body == null) throw new Error(`unstubbed URL: ${url}`)
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
      return new Response(Uint8Array.from(bytes), { status: 200 })
    }),
  )
}

function dataUrl(buf: Buffer): string {
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buf.toString('base64')}`
}

describe('pickDocumentImageCandidates', () => {
  it('selects document attachments by format, independent of crawler-specific kind', () => {
    const candidates = pickDocumentImageCandidates([
      attachment({ kind: 'other', filename: 'terms.txt', proxyUrl: 'https://example.test/terms.txt' }),
      attachment({ kind: 'photo', filename: 'Foto.pdf', proxyUrl: 'https://example.test/foto.pdf' }),
      attachment({ kind: 'announcement', filename: 'notice.docx', proxyUrl: 'https://example.test/notice.docx' }),
      attachment({ kind: 'brochure', filename: 'page.html', proxyUrl: 'https://example.test/page.html' }),
    ])

    expect(candidates.map((a) => a.filename)).toEqual(['Foto.pdf', 'notice.docx', 'page.html'])
  })
})

describe('extractHtmlImageUrls', () => {
  it('extracts src and srcset URLs relative to the HTML document', () => {
    const urls = extractHtmlImageUrls(
      '<img src="/a.jpg"><img srcset="small.jpg 400w, https://cdn.test/b.jpg 900w">',
      'https://example.test/docs/page.html',
    )

    expect(urls).toEqual([
      'https://example.test/a.jpg',
      'https://example.test/docs/small.jpg',
      'https://cdn.test/b.jpg',
    ])
  })
})

describe('extractDocumentPhotos', () => {
  let destDir: string

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), 'document-images-test-'))
    vi.mocked(extractPdfPhotos).mockClear()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(destDir, { recursive: true, force: true })
  })

  it('dispatches PDF attachments through the existing poppler extractor', async () => {
    const files = await extractDocumentPhotos([
      attachment({ filename: 'report.pdf', proxyUrl: 'https://example.test/report.pdf' }),
    ], { destDir })

    expect(files).toEqual(['pdf-photo.jpg'])
    expect(extractPdfPhotos).toHaveBeenCalledWith('https://example.test/report.pdf', { destDir })
  })

  it('extracts embedded DOCX media from word/media into content-addressable image files', async () => {
    const docx = zip([
      { name: 'word/document.xml', bytes: Buffer.from('<w:document/>') },
      { name: 'word/media/image1.png', bytes: png(1200, 800, 2) },
      { name: 'word/media/icon.png', bytes: png(64, 64, 3) },
    ])

    const files = await extractDocumentPhotos([
      attachment({ filename: 'report.docx', proxyUrl: dataUrl(docx) }),
    ], { destDir })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.png$/)
    expect(await readdir(destDir)).toEqual(files)
  })

  it('skips oversized inflated DOCX media entries and keeps processing later images', async () => {
    const docx = zip([
      { name: 'word/media/huge.png', bytes: Buffer.alloc(31 * 1024 * 1024, 1) },
      { name: 'word/media/image1.png', bytes: png(1200, 800, 6) },
    ])

    const files = await extractDocumentPhotos([
      attachment({ filename: 'report.docx', proxyUrl: dataUrl(docx) }),
    ], { destDir })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.png$/)
  })

  it('extracts and filters images referenced by HTML document attachments', async () => {
    stubFetch({
      'https://example.test/docs/page.html': '<img srcset="icon.png 64w, /large.png 1200w">',
      'https://example.test/docs/icon.png': png(64, 64, 4),
      'https://example.test/large.png': png(1200, 800, 5),
    })

    const files = await extractDocumentPhotos([
      attachment({ kind: 'brochure', filename: 'page.html', proxyUrl: 'https://example.test/docs/page.html' }),
    ], { destDir })

    expect(files).toHaveLength(1)
    expect(files.every((file) => /^[0-9a-f]{16}\.png$/.test(file))).toBe(true)
  })

  it('skips HTML image URLs that resolve to non-public addresses', async () => {
    stubFetch({
      'https://example.test/docs/page.html': '<img src="https://private.test/secret.png"><img src="/large.png">',
      'https://example.test/large.png': png(1200, 800, 7),
    })

    const files = await extractDocumentPhotos([
      attachment({ kind: 'brochure', filename: 'page.html', proxyUrl: 'https://example.test/docs/page.html' }),
    ], { destDir })

    expect(files).toHaveLength(1)
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      'https://private.test/secret.png',
      expect.anything(),
    )
  })
})
