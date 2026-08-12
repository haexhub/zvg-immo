import { describe, expect, it } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'
import type { AuctionRecord } from './auction-record'
import { classifyLlmStatus, hasMissingLlmFields } from './llm-status'

function extraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    units: 1,
    source: 'llm',
    confidence: 'high',
    at: '2026-08-01T10:00:00.000Z',
    condition: null,
    features: [],
    bedrooms: null,
    bathrooms: null,
    floor: null,
    bathroomHasTub: null,
    bathroomHasShower: null,
    heating: null,
    yearBuilt: null,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    planningNotes: null,
    documentSummary: null,
    marketValueEur: null,
    ...overrides,
  }
}

function record(overrides: { extraction?: AuctionExtraction; llmFailures?: number; llmClaimedAt?: string | null } = {}): AuctionRecord {
  return {
    detailsId: 1,
    detailsVersion: 1,
    artifactVersionId: null,
    auction: {
      platform: 'zvg-portal',
      externalId: '1',
      country: 'de',
      extraction: overrides.extraction,
      processing: {
        llmFailures: overrides.llmFailures ?? 0,
        llmClaimedAt: overrides.llmClaimedAt ?? null,
        photoFailures: 0,
        llmBatchJob: null,
        photosCheckedAt: null,
        photoPipelineVersion: null,
      },
    } as never,
  }
}

describe('hasMissingLlmFields', () => {
  it('is false once every LLM-only field has been set (even to null)', () => {
    expect(hasMissingLlmFields(extraction())).toBe(false)
  })

  it('is true when an LLM-only field was never touched (undefined)', () => {
    expect(hasMissingLlmFields(extraction({ condition: undefined }))).toBe(true)
  })
})

describe('classifyLlmStatus', () => {
  it('is "error" once llmFailures reaches MAX_LLM_FAILURES, regardless of extraction state', () => {
    expect(classifyLlmStatus(record({ extraction: extraction(), llmFailures: 3 }))).toBe('error')
  })

  it('is "open" when never extracted', () => {
    expect(classifyLlmStatus(record({ llmFailures: 0 }))).toBe('open')
  })

  it('is "open" when stuck on low-confidence rules', () => {
    expect(classifyLlmStatus(record({ extraction: extraction({ source: 'rules', confidence: 'low' }) }))).toBe('open')
  })

  it('is "open" when an LLM-only field is still missing', () => {
    expect(classifyLlmStatus(record({ extraction: extraction({ condition: undefined }) }))).toBe('open')
  })

  it('is "done" once successfully extracted with every field present', () => {
    expect(classifyLlmStatus(record({ extraction: extraction() }))).toBe('done')
  })

  it('is "done" once llmAnalyzedAt is set, even if llmFailures later reached MAX_LLM_FAILURES', () => {
    expect(
      classifyLlmStatus(record({ extraction: extraction({ llmAnalyzedAt: '2026-08-01T10:00:00.000Z' }), llmFailures: 3 })),
    ).toBe('done')
  })

  it('is "done" once llmAnalyzedAt is set, even if an optional LLM-only field is still missing', () => {
    expect(
      classifyLlmStatus(record({ extraction: extraction({ llmAnalyzedAt: '2026-08-01T10:00:00.000Z', condition: undefined }) })),
    ).toBe('done')
  })

  it('is "pending" when a fresh LLM claim overrides a previous failure lockout', () => {
    expect(
      classifyLlmStatus(record({ llmFailures: 3, llmClaimedAt: new Date().toISOString() })),
    ).toBe('pending')
  })

  it('is "pending" when a fresh LLM claim overrides the open/unextracted state', () => {
    expect(classifyLlmStatus(record({ llmClaimedAt: new Date().toISOString() }))).toBe('pending')
  })

  it('falls back to error/open once a claim is older than the lease', () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    expect(classifyLlmStatus(record({ llmFailures: 3, llmClaimedAt: stale }))).toBe('error')
    expect(classifyLlmStatus(record({ llmClaimedAt: stale }))).toBe('open')
  })

  it('stays "done" once llmAnalyzedAt is set even with a fresh claim (e.g. a forced re-run)', () => {
    expect(
      classifyLlmStatus(record({ extraction: extraction({ llmAnalyzedAt: '2026-08-01T10:00:00.000Z' }), llmClaimedAt: new Date().toISOString() })),
    ).toBe('done')
  })
})
