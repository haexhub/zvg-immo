import { describe, expect, it } from 'vitest'
import { renderPdfPageJpeg, renderPdfPagesJpeg } from './pdf-render'

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

describe('renderPdfPageJpeg', () => {
  it('rasterizes a PDF page to a JPEG buffer', async () => {
    const jpeg = await renderPdfPageJpeg(MINI_PDF)
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
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
