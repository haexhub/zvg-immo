import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPdfBuffer } from './pdf-text'

vi.mock('./pdf-text', () => ({ fetchPdfBuffer: vi.fn() }))

const { pdfPageToBase64Jpeg, renderPdfPageJpeg } = await import('./pdf-render')

// Minimal one-page PDF (no proper xref table) — poppler recovers these via
// brute-force scanning, so this renders a real JPEG without needing a full
// spec-compliant fixture.
const MINI_PDF = Buffer.from(
  [
    '%PDF-1.1',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 41>>stream',
    '1 0 0 RG 10 10 180 180 re S',
    'endstream',
    'endobj',
    'trailer<</Root 1 0 R/Size 5>>',
    '%%EOF',
    '',
  ].join('\n'),
)

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-render')

async function cleanupRenderCache(url: string): Promise<void> {
  const key = createHash('sha1').update(`${url}#1`).digest('hex')
  await rm(join(CACHE_DIR, `${key}.jpg`), { force: true })
}

describe('renderPdfPageJpeg', () => {
  it('rasterizes a PDF page to a JPEG buffer', async () => {
    const jpeg = await renderPdfPageJpeg(MINI_PDF)
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })
})

describe('pdfPageToBase64Jpeg', () => {
  afterEach(async () => {
    await cleanupRenderCache('https://example.test/scanned.pdf')
  })

  it('fetches, renders and base64-encodes the page, then caches on disk', async () => {
    const url = 'https://example.test/scanned.pdf'
    await cleanupRenderCache(url)
    vi.mocked(fetchPdfBuffer).mockResolvedValue(MINI_PDF)

    const first = await pdfPageToBase64Jpeg(url)
    expect(first).not.toBeNull()
    expect(Buffer.from(first!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(fetchPdfBuffer).toHaveBeenCalledTimes(1)

    const second = await pdfPageToBase64Jpeg(url)
    expect(second).toBe(first)
    // Cache hit — no second fetch.
    expect(fetchPdfBuffer).toHaveBeenCalledTimes(1)
  })

  it('returns null when the PDF fails to download', async () => {
    vi.mocked(fetchPdfBuffer).mockResolvedValue(null)
    expect(await pdfPageToBase64Jpeg('https://example.test/missing.pdf')).toBeNull()
  })
})
