import { describe, expect, it } from 'vitest'
import { clampExtraction, parseExtractionResponse } from './llm'

describe('parseExtractionResponse', () => {
  it('returns the final_result tool_use input', () => {
    const resp = {
      content: [
        { type: 'tool_use', name: 'final_result', input: { propertyType: 'haus', landAreaSqm: 620 } },
      ],
    }
    expect(parseExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null when no tool_use block is present', () => {
    expect(parseExtractionResponse({ content: [{ type: 'text', text: 'hi' }] })).toBeNull()
  })

  it('returns null for malformed responses', () => {
    expect(parseExtractionResponse(null)).toBeNull()
    expect(parseExtractionResponse({})).toBeNull()
    expect(parseExtractionResponse({ content: 'nope' })).toBeNull()
  })
})

describe('clampExtraction', () => {
  it('keeps plausible values and a valid propertyType', () => {
    expect(
      clampExtraction({
        propertyType: 'einfamilienhaus',
        landAreaSqm: 620,
        livingAreaSqm: 140,
        rooms: 5,
        units: 1,
      }),
    ).toEqual({
      propertyType: 'einfamilienhaus',
      landAreaSqm: 620,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
    })
  })

  it('nulls an unknown propertyType', () => {
    expect(clampExtraction({ propertyType: 'castle' }).propertyType).toBeNull()
  })

  it('rejects non-positive and absurd areas', () => {
    const r = clampExtraction({ landAreaSqm: 0, livingAreaSqm: -5 })
    expect(r.landAreaSqm).toBeNull()
    expect(r.livingAreaSqm).toBeNull()
    expect(clampExtraction({ landAreaSqm: 999_999_999_999 }).landAreaSqm).toBeNull()
  })

  it('coerces missing fields to null', () => {
    expect(clampExtraction({})).toEqual({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
    })
  })

  it('drops non-numeric junk', () => {
    expect(clampExtraction({ landAreaSqm: 'big' as unknown as number }).landAreaSqm).toBeNull()
  })
})
