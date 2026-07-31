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

  // Regression (CodeRabbit review on #279): the first implementation
  // pattern-matched the already-escaped JSON text for the 6-character
  // sequence a NUL produces. A literal backslash immediately followed by
  // literal "u0000" text becomes, once JSON.stringify escapes the backslash,
  // indistinguishable from that same 6-character sequence starting one
  // character later — a naive substring removal there stripped part of a
  // legitimate escaped backslash and produced invalid JSON. The replacer-based
  // fix never sees escaped text, only real characters, so this case is
  // unaffected by the sanitization at all.
  it('leaves a literal backslash followed by literal "u0000" text intact', () => {
    const value = { title: `Haus\\u0000Straße` }
    const result = jsonbStringify(value)
    expect(result).toBe(JSON.stringify(value))
    expect(JSON.parse(result)).toEqual(value)
  })

  it('sanitizes NUL characters in deeply nested strings, not just top-level fields', () => {
    const value = { auctions: [{ title: 'ok' }, { title: `Haus${NUL}Straße`, tags: [`a${NUL}b`] }] }
    const result = JSON.parse(jsonbStringify(value))
    expect(result.auctions[1].title).toBe('HausStraße')
    expect(result.auctions[1].tags[0]).toBe('ab')
  })
})
