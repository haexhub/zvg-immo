import { describe, expect, it, vi } from 'vitest'
import {
  buildDocumentLlmParts,
  buildDocumentSummaryInputs,
  MAX_MAP_REDUCE_DOCUMENTS,
  MAX_MAP_REDUCE_DOCUMENT_TEXT_CHARS,
} from './pdf-documents'

describe('buildDocumentLlmParts', () => {
  it('labels and combines text from multiple documents', async () => {
    const result = await buildDocumentLlmParts([
      { source: 'a', label: 'Gutachten', text: 'Langer Inhalt '.repeat(20) },
      { source: 'b', label: 'Exposé', text: 'Weitere Angaben '.repeat(20) },
    ], { native: false })

    expect(result.pdfText).toContain('=== Gutachten ===')
    expect(result.pdfText).toContain('=== Exposé ===')
    expect(result.pdfPageImages).toBeNull()
    expect(result.pdfBytes).toBeNull()
  })

  it('ignores raw PDF bytes in text mode for non-native batch providers', async () => {
    const result = await buildDocumentLlmParts([
      { source: 'a', label: 'Gutachten', text: 'Verwertbarer Text '.repeat(20), data: 'base64-a' },
    ], { native: false })

    expect(result.pdfText).toContain('Verwertbarer Text')
    expect(result.pdfBytes).toBeNull()
    expect(result.pdfDocuments).toBeUndefined()
  })

  it('renders only short or empty text documents with the shared limits', async () => {
    const renderPages = vi.fn(async (source: string, maxPages: number) => [
      `${source}-page-1`,
      `${source}-page-2`,
    ])
    const result = await buildDocumentLlmParts([
      { source: 'scanned-a', label: 'Scan A', text: null },
      { source: 'text', label: 'Text', text: 'Echter Text '.repeat(30) },
      { source: 'scanned-b', label: 'Scan B', text: 'noise' },
    ], { native: false, renderPages })

    expect(renderPages).toHaveBeenCalledTimes(2)
    expect(renderPages).toHaveBeenCalledWith('scanned-a', 8)
    expect(renderPages).toHaveBeenCalledWith('scanned-b', 8)
    expect(result.pdfPageImages).toEqual([
      'scanned-a-page-1',
      'scanned-a-page-2',
      'scanned-b-page-1',
      'scanned-b-page-2',
    ])
  })

  it('uses the scalar native fallback for exactly one document', async () => {
    const result = await buildDocumentLlmParts([
      { source: 'a', label: 'Gutachten', data: 'base64-a' },
    ], { native: true })

    expect(result).toEqual({
      pdfText: null,
      pdfPageImages: null,
      pdfBytes: 'base64-a',
      pdfDocuments: undefined,
    })
  })

  it('uses only the multi-document collection for several native PDFs', async () => {
    const result = await buildDocumentLlmParts([
      { source: 'a', label: 'Teil 1', data: 'base64-a' },
      { source: 'b', label: 'Teil 2', data: 'base64-b' },
    ], { native: true })

    expect(result.pdfBytes).toBeNull()
    expect(result.pdfDocuments).toEqual([
      { label: 'Teil 1', data: 'base64-a' },
      { label: 'Teil 2', data: 'base64-b' },
    ])
  })
})

describe('buildDocumentSummaryInputs', () => {
  it('returns one group per document when at or under the cap', async () => {
    const docs = Array.from({ length: MAX_MAP_REDUCE_DOCUMENTS }, (_, i) => ({
      source: `doc-${i}`,
      label: `Dokument ${i}`,
      text: `Inhalt ${i} `.repeat(20),
    }))
    const result = await buildDocumentSummaryInputs(docs, { native: false })

    expect(result).toHaveLength(MAX_MAP_REDUCE_DOCUMENTS)
    result.forEach((group, i) => {
      expect(group.label).toBe(`Dokument ${i}`)
      expect(group.parts.pdfText).toContain(`=== Dokument ${i} ===`)
    })
  })

  it('keeps overflow groups within the text budget and reports documents beyond five groups', async () => {
    const docs = Array.from({ length: MAX_MAP_REDUCE_DOCUMENTS + 3 }, (_, i) => ({
      source: `doc-${i}`,
      label: `Dokument ${i}`,
      text: `Inhalt ${i} `.repeat(2_500),
    }))
    const result = await buildDocumentSummaryInputs(docs, { native: false })

    expect(result).toHaveLength(MAX_MAP_REDUCE_DOCUMENTS)
    expect(result.every((group) => (group.parts.pdfText?.length ?? 0) <= MAX_MAP_REDUCE_DOCUMENT_TEXT_CHARS)).toBe(true)
    expect(result.slice(0, MAX_MAP_REDUCE_DOCUMENTS - 1).map((group) => group.label)).toEqual([
      'Dokument 0', 'Dokument 1', 'Dokument 2', 'Dokument 3',
    ])
    expect(result.at(-1)?.documentLabels).toEqual(['Dokument 4'])
    expect(result.at(-1)?.deferredDocumentLabels).toEqual(['Dokument 5', 'Dokument 6', 'Dokument 7'])
  })

  it('never sends more scanned documents than the renderer can include in one group', async () => {
    const docs = Array.from({ length: MAX_MAP_REDUCE_DOCUMENTS + 3 }, (_, i) => ({
      source: `scan-${i}`,
      label: `Scan ${i}`,
      text: null,
    }))
    const renderPages = vi.fn(async (source: string) => [`${source}-page`])

    const result = await buildDocumentSummaryInputs(docs, { native: false, renderPages })

    expect(result).toHaveLength(MAX_MAP_REDUCE_DOCUMENTS)
    expect(renderPages).toHaveBeenCalledTimes(7)
    expect(renderPages.mock.calls.map(([source]) => source)).not.toContain('scan-7')
    expect(result.at(-1)?.deferredDocumentLabels).toEqual(['Scan 7'])
  })

  it('returns an empty array for no documents', async () => {
    expect(await buildDocumentSummaryInputs([], { native: false })).toEqual([])
  })

  it('threads native mode through to each group', async () => {
    const docs = [
      { source: 'a', label: 'Teil 1', data: 'base64-a' },
      { source: 'b', label: 'Teil 2', data: 'base64-b' },
    ]
    const result = await buildDocumentSummaryInputs(docs, { native: true })
    expect(result).toEqual([
      { label: 'Teil 1', documentLabels: ['Teil 1'], parts: { pdfText: null, pdfPageImages: null, pdfBytes: 'base64-a', pdfDocuments: undefined } },
      { label: 'Teil 2', documentLabels: ['Teil 2'], parts: { pdfText: null, pdfPageImages: null, pdfBytes: 'base64-b', pdfDocuments: undefined } },
    ])
  })
})
