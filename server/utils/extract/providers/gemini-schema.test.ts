import { describe, expect, it } from 'vitest'
import { toGeminiSchema } from './gemini-schema'

describe('toGeminiSchema', () => {
  it('converts a nullable string with enum to STRING + nullable, dropping the null enum entry', () => {
    expect(
      toGeminiSchema({
        type: ['string', 'null'],
        enum: ['haus', 'wohnung', null],
        description: 'Objektart, oder null wenn unklar.',
      }),
    ).toEqual({
      type: 'STRING',
      nullable: true,
      enum: ['haus', 'wohnung'],
      description: 'Objektart, oder null wenn unklar.',
    })
  })

  it('converts a plain (non-nullable) number', () => {
    expect(toGeminiSchema({ type: ['number', 'null'], description: 'Fläche in m².' })).toEqual({
      type: 'NUMBER',
      nullable: true,
      description: 'Fläche in m².',
    })
    expect(toGeminiSchema({ type: 'number' })).toEqual({ type: 'NUMBER' })
  })

  it('converts an array of enum strings without null in the item enum', () => {
    expect(
      toGeminiSchema({
        type: 'array',
        items: { type: 'string', enum: ['balkon', 'garage'] },
        description: 'Ausstattungsmerkmale.',
      }),
    ).toEqual({
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['balkon', 'garage'] },
      description: 'Ausstattungsmerkmale.',
    })
  })

  it('recurses into object properties, keeps required, drops additionalProperties', () => {
    const canonical = {
      type: 'object',
      additionalProperties: false,
      properties: {
        propertyType: { type: ['string', 'null'], enum: ['haus', null] },
        rooms: { type: ['number', 'null'] },
      },
      required: ['propertyType', 'rooms'],
    }
    expect(toGeminiSchema(canonical)).toEqual({
      type: 'OBJECT',
      properties: {
        propertyType: { type: 'STRING', nullable: true, enum: ['haus'] },
        rooms: { type: 'NUMBER', nullable: true },
      },
      required: ['propertyType', 'rooms'],
    })
  })
})
