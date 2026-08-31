import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClampedExtraction, LlmConfig, LlmInput } from '~/server/utils/extract/llm'
import type { DocumentSummaryInput } from '~/server/utils/extract/pdf-documents'
import type { PreparedAttachmentDocument } from '~/server/utils/extract/llm-documents'

const extractByLlmMock = vi.fn()

vi.mock('~/server/utils/extract/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/extract/llm')>()
  return {
    ...actual,
    extractByLlm: extractByLlmMock,
    isRateLimitError: (err: unknown) => (err as { rateLimit?: boolean } | null)?.rateLimit === true,
    isDailyQuotaError: (err: unknown) => (err as { dailyQuota?: boolean } | null)?.dailyQuota === true,
  }
})

const { runMapReduceExtraction } = await import('./reprocess-map-reduce')
const { DOCUMENT_SUMMARY_SCHEMA_NAME } = await import('~/server/utils/extract/llm')

const config: LlmConfig = { baseUrl: 'https://example.test', model: 'test-model' }
const base: LlmInput = { title: 'Testauktion', description: 'Beschreibung' }

const groups: Array<DocumentSummaryInput<PreparedAttachmentDocument>> = [
  { label: 'Gutachten', parts: { pdfText: 'Gutachten Text', pdfPageImages: null, pdfBytes: null } },
  { label: 'Exposé', parts: { pdfText: 'Exposé Text', pdfPageImages: null, pdfBytes: null } },
]

function extraction(overrides: Partial<ClampedExtraction> = {}): ClampedExtraction {
  return {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    bathroomHasTub: null,
    bathroomHasShower: null,
    heating: null,
    units: null,
    securityDeposit: null,
    ruleCheck: null,
    biddingNotes: null,
    condition: null,
    features: [],
    yearBuilt: null,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    planningNotes: null,
    documentSummary: null,
    marketValueEur: null,
    marketValueText: null,
    photoCuration: [],
    ...overrides,
  }
}

function rateLimitError(): Error {
  return Object.assign(new Error('rate limited'), { rateLimit: true })
}

describe('runMapReduceExtraction', () => {
  beforeEach(() => {
    extractByLlmMock.mockReset()
  })

  it('maps each document with the document-summary schema, then reduces with the default schema', async () => {
    extractByLlmMock.mockImplementation(async (_input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      return opts.name === DOCUMENT_SUMMARY_SCHEMA_NAME
        ? extraction({ propertyType: 'eigentumswohnung' })
        : extraction({ propertyType: 'einfamilienhaus', documentSummary: 'reduced' })
    })

    const onLlmAttempt = vi.fn()
    const onLlmCall = vi.fn()
    const result = await runMapReduceExtraction(groups, base, config, { onLlmAttempt, onLlmCall })

    expect(result?.propertyType).toBe('einfamilienhaus')
    expect(extractByLlmMock).toHaveBeenCalledTimes(3) // 2 map + 1 reduce
    expect(onLlmAttempt).toHaveBeenCalledTimes(3)
    expect(onLlmCall).toHaveBeenCalledTimes(3)
    expect(onLlmCall.mock.calls.every(([call]) => call.status === 'succeeded')).toBe(true)

    const [mapCall1, mapCall2, reduceCall] = extractByLlmMock.mock.calls
    expect(mapCall1![2].name).toBe(DOCUMENT_SUMMARY_SCHEMA_NAME)
    expect(mapCall2![2].name).toBe(DOCUMENT_SUMMARY_SCHEMA_NAME)
    // Reduce gets no schema/systemPrompt/name override — it relies on
    // extractByLlm's own universal-schema default (covered by llm.test.ts).
    expect(reduceCall![2].name).toBeUndefined()
    expect(reduceCall![2].schema).toBeUndefined()
    // Reduce's input carries the map results as structured text, never raw
    // PDF content (pdfPageImages/pdfBytes) — the 288s-timeout failure mode
    // this whole feature exists to avoid can't recur at the reduce call.
    const reduceInput = reduceCall![0] as LlmInput
    expect(reduceInput.pdfText).toContain('Gutachten')
    expect(reduceInput.pdfText).toContain('eigentumswohnung')
    expect(reduceInput.pdfPageImages).toBeUndefined()
    expect(reduceInput.pdfBytes).toBeUndefined()
  })

  it('excludes a failed map document from the reduce input instead of aborting the candidate', async () => {
    extractByLlmMock.mockImplementation(async (_input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      if (opts.name !== DOCUMENT_SUMMARY_SCHEMA_NAME) return extraction({ documentSummary: 'reduced' })
      return _input.pdfText === 'Gutachten Text' ? null : extraction({ propertyType: 'eigentumswohnung' })
    })

    const result = await runMapReduceExtraction(groups, base, config, {})

    expect(result?.documentSummary).toBe('reduced')
    expect(extractByLlmMock).toHaveBeenCalledTimes(3)
    const reduceInput = extractByLlmMock.mock.calls[2]![0] as LlmInput
    expect(reduceInput.pdfText).toContain('Gutachten (Analyse fehlgeschlagen)')
    expect(reduceInput.pdfText).toContain('konnte nicht ausgewertet werden')
    expect(reduceInput.pdfText).toContain('Exposé')
    expect(reduceInput.pdfText).toContain('eigentumswohnung')
  })

  it('skips the reduce call entirely when every map document fails', async () => {
    extractByLlmMock.mockImplementation(async (_input: LlmInput, _cfg: LlmConfig, opts: { onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      return null
    })

    const result = await runMapReduceExtraction(groups, base, config, {})

    expect(result).toBeNull()
    expect(extractByLlmMock).toHaveBeenCalledTimes(2) // both maps attempted, no reduce
  })

  it('propagates a rate-limit error from a map call uncaught, without reaching reduce', async () => {
    extractByLlmMock.mockImplementation(async (input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      if (opts.name === DOCUMENT_SUMMARY_SCHEMA_NAME && input.pdfText === 'Gutachten Text') throw rateLimitError()
      return extraction()
    })

    await expect(runMapReduceExtraction(groups, base, config, {})).rejects.toThrow('rate limited')
    // The other map call may or may not have settled yet (Promise.all), but
    // reduce must never have been reached — only the 2 map calls happened.
    expect(extractByLlmMock).toHaveBeenCalledTimes(2)
  })

  it('propagates a rate-limit error from the reduce call uncaught', async () => {
    extractByLlmMock.mockImplementation(async (_input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      if (opts.name === DOCUMENT_SUMMARY_SCHEMA_NAME) return extraction()
      throw rateLimitError()
    })

    await expect(runMapReduceExtraction(groups, base, config, {})).rejects.toThrow('rate limited')
    expect(extractByLlmMock).toHaveBeenCalledTimes(3)
  })

  it('tolerates a non-rate-limit thrown error from a map call as a per-document failure', async () => {
    extractByLlmMock.mockImplementation(async (input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      if (opts.name === DOCUMENT_SUMMARY_SCHEMA_NAME && input.pdfText === 'Gutachten Text') {
        throw new Error('claude-proxy: ungültige oder leere Provider-Antwort')
      }
      return extraction({ documentSummary: 'ok' })
    })

    const result = await runMapReduceExtraction(groups, base, config, {})

    expect(result?.documentSummary).toBe('ok')
    expect(extractByLlmMock).toHaveBeenCalledTimes(3)
  })

  it('reports deferred documents in the reduce input', async () => {
    extractByLlmMock.mockImplementation(async (_input: LlmInput, _cfg: LlmConfig, opts: { name?: string; onProviderAttempt?: () => void }) => {
      opts.onProviderAttempt?.()
      return extraction({ documentSummary: opts.name === DOCUMENT_SUMMARY_SCHEMA_NAME ? 'map' : 'reduced' })
    })

    const result = await runMapReduceExtraction([
      ...groups,
      { label: 'Nicht gesendet', documentLabels: ['Nicht gesendet'], deferredDocumentLabels: ['Nicht gesendet'], parts: { pdfText: 'nicht gesendet', pdfPageImages: null, pdfBytes: null } },
    ], base, config, {})

    expect(result?.documentSummary).toBe('reduced')
    const reduceInput = extractByLlmMock.mock.calls[3]![0] as LlmInput
    expect(reduceInput.pdfText).toContain('Dokumente nicht ausgewertet')
    expect(reduceInput.pdfText).toContain('Nicht gesendet')
  })
})
