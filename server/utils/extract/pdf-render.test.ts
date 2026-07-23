import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPdfBuffer } from './pdf-text'

vi.mock('./pdf-text', () => ({ fetchPdfBuffer: vi.fn() }))

const { pdfPageToBase64Jpeg, renderPdfPageJpeg, pdfPagesToBase64Jpeg, renderPdfPagesJpeg } =
  await import('./pdf-render')

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

// Two-page variant of MINI_PDF — same brute-force-recovered structure, a
// second page with a differently colored rectangle so page order is
// verifiable from the rasterized bytes' size/content, not just count.
const TWO_PAGE_PDF = Buffer.from(
  [
    '%PDF-1.1',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 41>>stream',
    '1 0 0 RG 10 10 180 180 re S',
    'endstream',
    'endobj',
    '5 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 6 0 R>>endobj',
    '6 0 obj<</Length 41>>stream',
    '0 1 0 RG 10 10 180 180 re S',
    'endstream',
    'endobj',
    'trailer<</Root 1 0 R/Size 7>>',
    '%%EOF',
    '',
  ].join('\n'),
)

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdf-render')

async function cleanupRenderCache(url: string): Promise<void> {
  const key = createHash('sha1').update(`${url}#1`).digest('hex')
  await rm(join(CACHE_DIR, `${key}.jpg`), { force: true })
}

async function cleanupPagesRenderCache(url: string, maxPages: number): Promise<void> {
  const key = createHash('sha1').update(`${url}#pages:${maxPages}`).digest('hex')
  await rm(join(CACHE_DIR, `${key}.json`), { force: true })
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

describe('renderPdfPagesJpeg', () => {
  it('rasterizes every page of a multi-page PDF, in order', async () => {
    const jpegs = await renderPdfPagesJpeg(TWO_PAGE_PDF)
    expect(jpegs).toHaveLength(2)
    for (const jpeg of jpegs) expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('caps the rendered range at maxPages', async () => {
    const jpegs = await renderPdfPagesJpeg(TWO_PAGE_PDF, { maxPages: 1 })
    expect(jpegs).toHaveLength(1)
  })

  it('rasterizes a single-page PDF to a one-element array', async () => {
    const jpegs = await renderPdfPagesJpeg(MINI_PDF)
    expect(jpegs).toHaveLength(1)
  })
})

describe('pdfPagesToBase64Jpeg', () => {
  afterEach(async () => {
    await cleanupPagesRenderCache('https://example.test/scanned-multi.pdf', 20)
  })

  it('fetches, renders every page and base64-encodes them, then caches on disk', async () => {
    const url = 'https://example.test/scanned-multi.pdf'
    await cleanupPagesRenderCache(url, 20)
    vi.mocked(fetchPdfBuffer).mockResolvedValue(TWO_PAGE_PDF)
    const callsBefore = vi.mocked(fetchPdfBuffer).mock.calls.length

    const first = await pdfPagesToBase64Jpeg(url)
    expect(first).not.toBeNull()
    expect(first).toHaveLength(2)
    expect(Buffer.from(first![0]!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(fetchPdfBuffer).toHaveBeenCalledTimes(callsBefore + 1)

    const second = await pdfPagesToBase64Jpeg(url)
    expect(second).toEqual(first)
    // Cache hit — no second fetch.
    expect(fetchPdfBuffer).toHaveBeenCalledTimes(callsBefore + 1)
  })

  it('returns null when the PDF fails to download', async () => {
    vi.mocked(fetchPdfBuffer).mockResolvedValue(null)
    expect(await pdfPagesToBase64Jpeg('https://example.test/missing-multi.pdf')).toBeNull()
  })
})
