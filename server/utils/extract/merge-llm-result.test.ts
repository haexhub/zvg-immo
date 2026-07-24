import { describe, expect, it } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'
import type { ClampedExtraction } from './llm'
import { mergeLlmResult, type MergeInputFields } from './merge-llm-result'

const AT = '2026-07-23T00:00:00.000Z'

function baseFields(overrides: Partial<MergeInputFields> = {}): MergeInputFields {
  return {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    units: null,
    securityDeposit: null,
    confident: false,
    ...overrides,
  }
}

function llmResult(overrides: Partial<ClampedExtraction> = {}): ClampedExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    units: 1,
    securityDeposit: null,
    biddingNotes: null,
    condition: 'neuwertig',
    features: ['balkon'],
    yearBuilt: 1990,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    photoCuration: [],
    marketValueEur: null,
    marketValueText: null,
    ...overrides,
  }
}

describe('mergeLlmResult', () => {
  it('lets the LLM fill propertyType/sizes when rules were not confident', () => {
    const entry = mergeLlmResult(undefined, baseFields({ confident: false }), llmResult(), AT, undefined)

    expect(entry.source).toBe('llm')
    expect(entry.propertyType).toBe('einfamilienhaus')
    expect(entry.landAreaSqm).toBe(500)
    expect(entry.confidence).toBe('high')
  })

  it('keeps source rules and ignores propertyType/sizes when rules were already confident', () => {
    const fields = baseFields({ confident: true, propertyType: 'eigentumswohnung', landAreaSqm: 80 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ propertyType: 'einfamilienhaus', landAreaSqm: 999 }), AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.propertyType).toBe('eigentumswohnung')
    expect(entry.landAreaSqm).toBe(80)
    expect(entry.biddingNotes).toBeUndefined()
  })

  it('always applies LLM-only fields (condition/features/yearBuilt/...) regardless of confidence', () => {
    const fields = baseFields({ confident: true, propertyType: 'eigentumswohnung', landAreaSqm: 80 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ condition: 'sanierungsbeduerftig' }), AT, undefined)

    expect(entry.condition).toBe('sanierungsbeduerftig')
    expect(entry.features).toEqual(['balkon'])
    expect(entry.yearBuilt).toBe(1990)
  })

  it('does not fill an already-set field from the LLM (rules/source values win)', () => {
    const fields = baseFields({ confident: false, rooms: 3 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ rooms: 7 }), AT, undefined)

    expect(entry.rooms).toBe(3)
  })

  it('bumps llmFailures on a failed call and leaves fields untouched', () => {
    const priorEntry = { llmFailures: 1 } as AuctionExtraction
    const fields = baseFields({ confident: false, condition: 'neuwertig' })
    const entry = mergeLlmResult(priorEntry, fields, null, AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.condition).toBe('neuwertig')
    expect(entry.llmFailures).toBe(2)
  })

  it('starts llmFailures at 1 on a failed call with no prior failures', () => {
    const entry = mergeLlmResult(undefined, baseFields(), null, AT, undefined)
    expect(entry.llmFailures).toBe(1)
  })

  it('resets llmFailures to 0 (omitted) on any successful call, even when source stays rules', () => {
    const priorEntry = { llmFailures: 2 } as AuctionExtraction
    const fields = baseFields({ confident: true, propertyType: 'eigentumswohnung', landAreaSqm: 80 })
    const entry = mergeLlmResult(priorEntry, fields, llmResult(), AT, undefined)

    expect(entry.llmFailures).toBeUndefined()
  })

  it('reports low confidence when neither type nor area could be resolved', () => {
    const entry = mergeLlmResult(undefined, baseFields(), llmResult({ propertyType: null, landAreaSqm: null, livingAreaSqm: null }), AT, undefined)
    expect(entry.confidence).toBe('low')
  })

  it('passes photos through unchanged', () => {
    const photos = [{ file: 'a.jpg', category: 'aussen' as const, caption: null, isPropertyPhoto: true }]
    const entry = mergeLlmResult(undefined, baseFields(), llmResult(), AT, photos)
    expect(entry.photos).toBe(photos)
  })

  it('stamps the given timestamp', () => {
    const entry = mergeLlmResult(undefined, baseFields(), llmResult(), AT, undefined)
    expect(entry.at).toBe(AT)
  })
})
