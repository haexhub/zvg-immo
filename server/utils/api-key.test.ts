import { describe, expect, it } from 'vitest'
import { generateApiKey, hashApiKey } from './api-key'

describe('generateApiKey', () => {
  it('returns a plaintext key whose hash round-trips through hashApiKey', () => {
    const { plaintext, hash } = generateApiKey()
    expect(hashApiKey(plaintext)).toBe(hash)
  })

  it('derives the prefix from the first 8 chars of the plaintext', () => {
    const { plaintext, prefix } = generateApiKey()
    expect(prefix).toBe(plaintext.slice(0, 8))
    expect(prefix).toHaveLength(8)
  })

  it('produces distinct keys on each call', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hashes different plaintexts to different hashes', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(hashApiKey(a.plaintext)).not.toBe(hashApiKey(b.plaintext))
  })
})
