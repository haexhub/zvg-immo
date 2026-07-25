import { describe, expect, it, vi } from 'vitest'
import { buildDocumentLlmParts } from './pdf-documents'

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
