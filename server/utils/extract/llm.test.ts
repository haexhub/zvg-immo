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
        securityDeposit: 5000,
        biddingNotes: 'Abweichende Sicherheitsleistung von 5.000 EUR gefordert.',
      }),
    ).toEqual({
      propertyType: 'einfamilienhaus',
      landAreaSqm: 620,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
      securityDeposit: 5000,
      biddingNotes: 'Abweichende Sicherheitsleistung von 5.000 EUR gefordert.',
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
      securityDeposit: null,
      biddingNotes: null,
    })
  })

  it('drops non-numeric junk', () => {
    expect(clampExtraction({ landAreaSqm: 'big' as unknown as number }).landAreaSqm).toBeNull()
  })

  it('rejects a non-positive or absurd securityDeposit', () => {
    expect(clampExtraction({ securityDeposit: 0 }).securityDeposit).toBeNull()
    expect(clampExtraction({ securityDeposit: -100 }).securityDeposit).toBeNull()
    expect(clampExtraction({ securityDeposit: 999_999_999_999 }).securityDeposit).toBeNull()
  })

  it('keeps a plausible securityDeposit', () => {
    expect(clampExtraction({ securityDeposit: 3000 }).securityDeposit).toBe(3000)
  })

  it('trims and caps biddingNotes, nulls blank/non-string values', () => {
    expect(clampExtraction({ biddingNotes: '  ein Hinweis  ' }).biddingNotes).toBe('ein Hinweis')
    expect(clampExtraction({ biddingNotes: '   ' }).biddingNotes).toBeNull()
    expect(clampExtraction({ biddingNotes: 42 as unknown as string }).biddingNotes).toBeNull()
    expect(clampExtraction({ biddingNotes: 'x'.repeat(500) }).biddingNotes).toHaveLength(300)
  })
})
