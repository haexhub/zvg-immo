import { describe, expect, it, vi } from 'vitest'
import { buildDocumentLlmParts, buildDocumentSummaryInputs, MAX_MAP_REDUCE_DOCUMENTS } from './pdf-documents'

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

  it('folds documents beyond the cap into one overflow group', async () => {
    const docs = Array.from({ length: MAX_MAP_REDUCE_DOCUMENTS + 3 }, (_, i) => ({
      source: `doc-${i}`,
      label: `Dokument ${i}`,
      text: `Inhalt ${i} `.repeat(20),
    }))
    const result = await buildDocumentSummaryInputs(docs, { native: false })

    // MAX_MAP_REDUCE_DOCUMENTS - 1 individual groups + 1 overflow group,
    // never more than MAX_MAP_REDUCE_DOCUMENTS calls regardless of input size.
    expect(result).toHaveLength(MAX_MAP_REDUCE_DOCUMENTS)
    const individual = result.slice(0, MAX_MAP_REDUCE_DOCUMENTS - 1)
    individual.forEach((group, i) => expect(group.label).toBe(`Dokument ${i}`))
    const overflow = result[MAX_MAP_REDUCE_DOCUMENTS - 1]!
    expect(overflow.label).toBe('4 weitere Dokumente')
    for (let i = MAX_MAP_REDUCE_DOCUMENTS - 1; i < docs.length; i++) {
      expect(overflow.parts.pdfText).toContain(`=== Dokument ${i} ===`)
    }
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
      { label: 'Teil 1', parts: { pdfText: null, pdfPageImages: null, pdfBytes: 'base64-a', pdfDocuments: undefined } },
      { label: 'Teil 2', parts: { pdfText: null, pdfPageImages: null, pdfBytes: 'base64-b', pdfDocuments: undefined } },
    ])
  })
})
