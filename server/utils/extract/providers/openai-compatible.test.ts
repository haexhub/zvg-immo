import { describe, expect, it } from 'vitest'
import { parseOpenAiExtractionResponse, toOpenAiContent } from './openai-compatible'

describe('toOpenAiContent', () => {
  it('translates text and image parts, dropping document parts', () => {
    expect(
      toOpenAiContent([
        { type: 'text', text: 'hallo' },
        { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
        { type: 'document', mimeType: 'application/pdf', data: 'BBBB' },
      ]),
    ).toEqual([
      { type: 'text', text: 'hallo' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ])
  })

  it('returns an empty array for no parts', () => {
    expect(toOpenAiContent([])).toEqual([])
  })
})

describe('parseOpenAiExtractionResponse', () => {
  it('parses the JSON string from the first choice message content', () => {
    const resp = { choices: [{ message: { content: '{"propertyType":"haus","landAreaSqm":620}' } }] }
    expect(parseOpenAiExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null for malformed responses', () => {
    expect(parseOpenAiExtractionResponse(null)).toBeNull()
    expect(parseOpenAiExtractionResponse({})).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [] })).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [{ message: { content: 'not json' } }] })).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [{ message: { content: '"just a string"' } }] })).toBeNull()
  })
})
