import { beforeEach, describe, expect, it, vi } from 'vitest'

const { archiveBlob } = vi.hoisted(() => ({ archiveBlob: vi.fn(async () => 'md-hash') }))
const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn(async () => null as Buffer | null) }))

vi.mock('../raw-archive', () => ({ archiveBlob }))
vi.mock('../storage-download', () => ({ downloadBlob }))

let doclingUrl = 'http://docling:5001'
vi.stubGlobal('useRuntimeConfig', () => ({ doclingUrl }))

const { convertPdfToMarkdown, doclingSupportsCountry, markdownForPdf } = await import('./docling')

const PDF = Buffer.from('%PDF-1.4 fake')

function fakePool(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (/^SELECT/i.test(sql.trim())) return { rows }
    return { rows: [] }
  })
  return { query } as unknown as Parameters<typeof markdownForPdf>[0] & { query: typeof query }
}

function stubFetch() {
  const mock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse(''))
  vi.stubGlobal('fetch', mock)
  return mock
}

function okResponse(markdown: string) {
  return { ok: true, status: 200, json: async () => ({ status: 'success', document: { md_content: markdown } }) }
}

beforeEach(() => {
  doclingUrl = 'http://docling:5001'
  vi.restoreAllMocks()
  archiveBlob.mockClear()
  downloadBlob.mockClear()
  archiveBlob.mockResolvedValue('md-hash')
  downloadBlob.mockResolvedValue(null)
})

describe('doclingSupportsCountry', () => {
  // Measured on prod 2026-07-31: the auto-selected OCR model drops Cyrillic
  // prose, which is worse than the previous path for these documents.
  it('excludes Bulgaria regardless of case', () => {
    expect(doclingSupportsCountry('bg')).toBe(false)
    expect(doclingSupportsCountry('BG')).toBe(false)
  })

  it('allows everything else, including unknown countries', () => {
    expect(doclingSupportsCountry('de')).toBe(true)
    expect(doclingSupportsCountry(null)).toBe(true)
  })
})

describe('convertPdfToMarkdown', () => {
  it('posts the PDF and returns the markdown content', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(okResponse('## Titel\n\n| a | b |'))

    expect(await convertPdfToMarkdown(PDF, 'Gutachten.pdf')).toBe('## Titel\n\n| a | b |')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://docling:5001/v1/convert/file')
    const form = init!.body as FormData
    expect(form.get('to_formats')).toBe('md')
    expect(form.get('table_mode')).toBe('accurate')
    // Photos come from the pdfimages pipeline, not from the markdown.
    expect(form.get('image_export_mode')).toBe('placeholder')
  })

  it('returns null without calling out when no URL is configured', async () => {
    doclingUrl = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await convertPdfToMarkdown(PDF, 'x.pdf')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    expect(await convertPdfToMarkdown(PDF, 'x.pdf')).toBeNull()
  })

  it('returns null when the response carries no markdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'failure', document: { md_content: '   ' } }),
    })))
    expect(await convertPdfToMarkdown(PDF, 'x.pdf')).toBeNull()
  })

  it('returns null when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await convertPdfToMarkdown(PDF, 'x.pdf')).toBeNull()
  })

  // Two concurrent conversions would double peak memory in the Docling
  // container, which is what OOM-killed the service during the prod test.
  it('never runs two conversions at once', async () => {
    let active = 0
    let maxActive = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return okResponse('# ok')
    }))

    await Promise.all([
      convertPdfToMarkdown(PDF, 'a.pdf'),
      convertPdfToMarkdown(PDF, 'b.pdf'),
      convertPdfToMarkdown(PDF, 'c.pdf'),
    ])

    expect(maxActive).toBe(1)
  })

  it('keeps the queue alive after a failed conversion', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(okResponse('# danach'))
    vi.stubGlobal('fetch', fetchMock)

    expect(await convertPdfToMarkdown(PDF, 'a.pdf')).toBeNull()
    expect(await convertPdfToMarkdown(PDF, 'b.pdf')).toBe('# danach')
  })
})

describe('markdownForPdf', () => {
  it('converts, archives the markdown and records the cache row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('# Konvertiert')))
    const db = fakePool()

    const md = await markdownForPdf(db, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })

    expect(md).toBe('# Konvertiert')
    expect(archiveBlob).toHaveBeenCalledWith(Buffer.from('# Konvertiert', 'utf8'), 'text/plain', 'de')
    const insert = db.query.mock.calls.find((call) => /INSERT INTO document_markdown/i.test(call[0]))
    expect(insert?.[1]).toEqual(['pdf-hash', 'md-hash', null])
  })

  it('serves a cached conversion without calling Docling again', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    downloadBlob.mockResolvedValue(Buffer.from('# Aus dem Cache', 'utf8'))
    const db = fakePool([{ markdown_content_hash: 'md-hash', failed_at: null }])

    expect(await markdownForPdf(db, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })).toBe('# Aus dem Cache')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Docling costs minutes per document; retrying a PDF it already choked on
  // would burn that on every hourly reprocess run.
  it('does not retry a previously failed conversion', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const db = fakePool([{ markdown_content_hash: null, failed_at: new Date() }])

    expect(await markdownForPdf(db, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records the failure so the next run skips the document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const db = fakePool()

    expect(await markdownForPdf(db, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })).toBeNull()
    const insert = db.query.mock.calls.find((call) => /INSERT INTO document_markdown/i.test(call[0]))
    expect(insert?.[1]?.[1]).toBeNull()
  })

  it('re-converts when the cache row points at unreadable bytes', async () => {
    const fetchMock = vi.fn(async () => okResponse('# Neu konvertiert'))
    vi.stubGlobal('fetch', fetchMock)
    downloadBlob.mockResolvedValue(null)
    const db = fakePool([{ markdown_content_hash: 'lost-hash', failed_at: null }])

    expect(await markdownForPdf(db, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })).toBe('# Neu konvertiert')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips excluded countries entirely', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await markdownForPdf(fakePool(), 'pdf-hash', PDF, { label: 'a.pdf', country: 'bg' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('converts without a cache when no database is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('# Ohne DB')))

    expect(await markdownForPdf(null, 'pdf-hash', PDF, { label: 'a.pdf', country: 'de' })).toBe('# Ohne DB')
    expect(archiveBlob).not.toHaveBeenCalled()
  })
})
