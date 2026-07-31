import { describe, expect, it } from 'vitest'
import { jsonbStringify } from './jsonb'

const NUL = String.fromCharCode(0)
// The escape sequence JSON.stringify emits for a NUL character, built from
// character codes so this test file never contains the literal escape or a
// real NUL byte, same rationale as jsonb.ts.
const JSON_ESCAPED_NUL = String.fromCharCode(92, 117, 48, 48, 48, 48)

describe('jsonbStringify', () => {
  it('matches JSON.stringify for a value without a NUL character', () => {
    const value = { title: 'Einfamilienhaus', price: 1200 }
    expect(jsonbStringify(value)).toBe(JSON.stringify(value))
  })

  it('drops an embedded NUL character instead of the escape Postgres jsonb rejects', () => {
    const value = { title: `Haus${NUL}Straße` }
    expect(JSON.stringify(value)).toContain(JSON_ESCAPED_NUL)

    const result = jsonbStringify(value)
    expect(result).not.toContain(JSON_ESCAPED_NUL)
    expect(JSON.parse(result)).toEqual({ title: 'HausStraße' })
  })

  it('drops every NUL character, not just the first', () => {
    const value = { a: `x${NUL}y${NUL}z` }
    expect(JSON.parse(jsonbStringify(value))).toEqual({ a: 'xyz' })
  })

  it('leaves other control characters (not rejected by Postgres) untouched', () => {
    const value = { a: 'line1\nline2\ttabbed' }
    expect(jsonbStringify(value)).toBe(JSON.stringify(value))
  })
})
