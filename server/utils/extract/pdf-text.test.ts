import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'

vi.mock('../db', () => ({ getPool: vi.fn() }))

// Imported after the mock so the module under test picks up the mocked getPool.
const { fetchPdfBuffer, pdfHasSuspiciousCjkEncoding, pdfToText, pickAllPdfs, pickRelevantPdfs } =
  await import('./pdf-text')

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdftext')
const FAKE_PDF = Buffer.from('%PDF-1.4\n%%EOF')
// Missing a real xref table, but poppler's recovery mode reads it anyway and
// pdftotext prints "Hallo Welt" — unlike FAKE_PDF above (which pdftotext exits
// non-zero on), this exercises the archiveDocumentText path below.
const PDF_WITH_TEXT = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 200 200]/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    '5 0 obj<</Length 44>>',
    'stream',
    'BT /F1 24 Tf 10 100 Td (Hallo Welt) Tj ET',
    'endstream',
    'endobj',
    'trailer<</Size 6/Root 1 0 R>>',
    '%%EOF',
  ].join('\n'),
)

describe('pickRelevantPdfs', () => {
  it('keeps every listing-specific PDF in priority order and excludes generic other files', () => {
    const attachment = (kind: 'appraisal' | 'brochure' | 'announcement' | 'other', proxyUrl: string) => ({
      kind,
      label: kind,
      filename: `${kind}.pdf`,
      sizeBytes: null,
      fileId: proxyUrl,
      proxyUrl,
    })
    expect(
      pickRelevantPdfs([
        attachment('announcement', '/notice.pdf'),
        attachment('other', '/bidding.pdf'),
        attachment('appraisal', '/appraisal-1.pdf'),
        attachment('brochure', '/brochure.pdf'),
        attachment('appraisal', '/appraisal-2.pdf'),
        attachment('announcement', '/notice.pdf'),
      ]),
    ).toEqual([
      attachment('appraisal', '/appraisal-1.pdf'),
      attachment('appraisal', '/appraisal-2.pdf'),
      attachment('brochure', '/brochure.pdf'),
      attachment('announcement', '/notice.pdf'),
    ])
  })
})

describe('pickAllPdfs', () => {
  it('keeps every PDF attachment, including other documents, and drops non-PDF files', () => {
    const attachment = (kind: 'appraisal' | 'brochure' | 'announcement' | 'other', filename: string, proxyUrl: string) => ({
      kind,
      label: kind,
      filename,
      sizeBytes: null,
      fileId: proxyUrl,
      proxyUrl,
    })

    expect(
      pickAllPdfs([
        attachment('other', 'bidding.pdf', '/bidding.pdf'),
        attachment('appraisal', 'gutachten.pdf', '/gutachten.pdf'),
        attachment('brochure', 'expose.pdf', '/expose.pdf'),
        attachment('announcement', 'notice.pdf', '/notice.pdf'),
        attachment('other', 'photo.jpg', '/photo.jpg'),
        attachment('other', 'bidding.pdf', '/bidding.pdf'),
      ]),
    ).toEqual([
      attachment('appraisal', 'gutachten.pdf', '/gutachten.pdf'),
      attachment('brochure', 'expose.pdf', '/expose.pdf'),
      attachment('announcement', 'notice.pdf', '/notice.pdf'),
      attachment('other', 'bidding.pdf', '/bidding.pdf'),
    ])
  })
})

// A minimal Type0/CID font declaring Adobe's predefined Shift-JIS CMap —
// mirrors what a misconfigured scanner OCR tool embeds when it mismaps
// non-Latin text onto a CJK font. No real glyph data needed since pdffonts
// only inspects the font dictionary, not the content stream.
const CJK_ENCODED_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 200 200]/Contents 7 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type0/BaseFont/MS-Gothic/Encoding/90ms-RKSJ-H/DescendantFonts[5 0 R]>>endobj',
    '5 0 obj<</Type/Font/Subtype/CIDFontType2/BaseFont/MS-Gothic/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 2>>/FontDescriptor 6 0 R/DW 1000>>endobj',
    '6 0 obj<</Type/FontDescriptor/FontName/MS-Gothic/Flags 4/FontBBox[0 0 1000 1000]/ItalicAngle 0/Ascent 1000/Descent 0/CapHeight 1000/StemV 80>>endobj',
    '7 0 obj<</Length 44>>',
    'stream',
    'BT /F1 24 Tf 10 100 Td <8140> Tj ET',
    'endstream',
    'endobj',
    'trailer<</Size 8/Root 1 0 R>>',
    '%%EOF',
  ].join('\n'),
)

describe('pdfHasSuspiciousCjkEncoding', () => {
  it('trusts a normal Standard-encoded font', async () => {
    await expect(pdfHasSuspiciousCjkEncoding(PDF_WITH_TEXT)).resolves.toBe(true)
  })

  it('flags a font using a CJK CID encoding', async () => {
    await expect(pdfHasSuspiciousCjkEncoding(CJK_ENCODED_PDF)).resolves.toBe(false)
  })

  it('fails open on an unreadable PDF', async () => {
    await expect(pdfHasSuspiciousCjkEncoding(FAKE_PDF)).resolves.toBe(true)
  })
})

describe('fetchPdfBuffer resource bounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an oversized response before buffering its body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(51 * 1024 * 1024) }),
      body: { cancel },
    }))

    await expect(fetchPdfBuffer('https://example.test/oversized.pdf')).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
  })
})

async function cleanupTextCache(url: string): Promise<void> {
  const key = createHash('sha1').update(url).digest('hex')
  await rm(join(CACHE_DIR, `${key}.txt`), { force: true })
}

interface FakeBlobRow {
  s3_key: string
  content_type: string
}

/** Minimal in-memory stand-in for the `pg` Pool, matching raw-archive.ts's queries. */
function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures: Array<{ kind: string; platform: string; externalId: string; sourceUrl: string | null }> = []

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT uploaded_at FROM raw_blobs')) {
      const hash = params[0] as string
      return { rows: blobs.has(hash) ? [{ uploaded_at: null }] : [] }
    }
    if (sql.includes('INSERT INTO raw_blobs')) {
      const [hash, s3_key, content_type] = params as [string, string, string]
      if (!blobs.has(hash)) blobs.set(hash, { s3_key, content_type })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT content_hash FROM raw_captures')) {
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO raw_captures')) {
      const [, kind, platform, , , externalId, , , , sourceUrl] = params as [
        string, string, string, string, string | null, string, string | null, string | null, string, string | null,
      ]
      captures.push({ kind, platform, externalId, sourceUrl })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { blobs, captures, query }
}

describe('pdfToText document archiving', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'pdf-text-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(FAKE_PDF, { status: 200 })))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('archives the fetched PDF as a document capture when identity is passed', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = 'https://example.test/appraisal-a.pdf'
    await cleanupTextCache(url)

    await pdfToText(url, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(1)
    expect(pool.captures[0]).toMatchObject({ kind: 'document', platform: 'de', externalId: '1', sourceUrl: url })
    expect([...pool.blobs.values()][0]!.content_type).toBe('application/pdf')

    await cleanupTextCache(url)
  })

  it('does not archive when no identity is passed (e.g. the pdf-thumb path)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = 'https://example.test/appraisal-b.pdf'
    await cleanupTextCache(url)

    await pdfToText(url)

    expect(pool.blobs.size).toBe(0)
    expect(pool.captures).toHaveLength(0)

    await cleanupTextCache(url)
  })

  it('archives the extracted text as a document_text capture alongside the raw document', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(PDF_WITH_TEXT, { status: 200 })))

    const url = 'https://example.test/appraisal-text.pdf'
    await cleanupTextCache(url)

    const text = await pdfToText(url, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(text).toContain('Hallo Welt')
    expect(pool.blobs.size).toBe(2) // one 'document' (raw PDF), one 'document_text'
    expect(pool.captures).toHaveLength(2)
    expect(pool.captures.map((c) => c.kind).sort()).toEqual(['document', 'document_text'])
    const textCapture = pool.captures.find((c) => c.kind === 'document_text')
    expect(textCapture).toMatchObject({ platform: 'de', externalId: '1', sourceUrl: url })

    await cleanupTextCache(url)
  })

  it('does not archive document_text when pdftotext yields no usable output', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    // FAKE_PDF (no trailer) makes pdftotext exit non-zero, so stdout is null.

    const url = 'https://example.test/appraisal-blank.pdf'
    await cleanupTextCache(url)

    await pdfToText(url, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.captures.map((c) => c.kind)).not.toContain('document_text')

    await cleanupTextCache(url)
  })

  it('dedups the same PDF fetched for two different auctions (one blob, two captures)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const urlA = 'https://example.test/shared.pdf?a'
    const urlB = 'https://example.test/shared.pdf?b'
    await cleanupTextCache(urlA)
    await cleanupTextCache(urlB)

    await pdfToText(urlA, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })
    await pdfToText(urlB, {
      identity: { platform: 'de', country: 'de', externalId: '2' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(2)

    await cleanupTextCache(urlA)
    await cleanupTextCache(urlB)
  })
})
