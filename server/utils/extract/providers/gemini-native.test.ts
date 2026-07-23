import { describe, expect, it } from 'vitest'
import { parseGeminiExtractionResponse, toGeminiParts } from './gemini-native'

describe('toGeminiParts', () => {
  it('translates text, image and document parts to Gemini parts', () => {
    expect(
      toGeminiParts([
        { type: 'text', text: 'hallo' },
        { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
        { type: 'document', mimeType: 'application/pdf', data: 'BBBB' },
      ]),
    ).toEqual([
      { text: 'hallo' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { inlineData: { mimeType: 'application/pdf', data: 'BBBB' } },
    ])
  })

  it('returns an empty array for no parts', () => {
    expect(toGeminiParts([])).toEqual([])
  })
})

describe('parseGeminiExtractionResponse', () => {
  it('parses the JSON string from the first candidate part', () => {
    const resp = {
      candidates: [{ content: { parts: [{ text: '{"propertyType":"haus","landAreaSqm":620}' }] } }],
    }
    expect(parseGeminiExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null for malformed responses', () => {
    expect(parseGeminiExtractionResponse(null)).toBeNull()
    expect(parseGeminiExtractionResponse({})).toBeNull()
    expect(parseGeminiExtractionResponse({ candidates: [] })).toBeNull()
    expect(parseGeminiExtractionResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toBeNull()
  })
})
