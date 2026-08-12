import { describe, expect, it } from 'vitest'
import { estimateCostUsd, lookupModelPricing, resolveCostUsd } from './llm-pricing'

describe('lookupModelPricing', () => {
  it('finds a known model', () => {
    expect(lookupModelPricing('claude-haiku-4-5')).toEqual({ inputPerMillion: 1, outputPerMillion: 5 })
  })

  it('finds the claude-proxy default model', () => {
    expect(lookupModelPricing('claude-sonnet-5')).toEqual({ inputPerMillion: 3, outputPerMillion: 15 })
  })

  it('strips a :batch suffix before lookup', () => {
    expect(lookupModelPricing('gemini-flash-latest:batch')).toEqual({ inputPerMillion: 0.3, outputPerMillion: 2.5 })
  })

  it('returns null for an unknown model', () => {
    expect(lookupModelPricing('some/unlisted-model')).toBeNull()
  })
})

describe('estimateCostUsd', () => {
  it('computes cost for a known model', () => {
    const cost = estimateCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(6, 6)
  })

  it('treats a null token count as zero, not as unknown', () => {
    const cost = estimateCostUsd('claude-haiku-4-5', 1_000_000, null)
    expect(cost).toBeCloseTo(1, 6)
  })

  it('returns null for an unpriced model', () => {
    expect(estimateCostUsd('some/unlisted-model', 100, 100)).toBeNull()
  })

  it('returns null when both token counts are null', () => {
    expect(estimateCostUsd('claude-haiku-4-5', null, null)).toBeNull()
  })
})

describe('resolveCostUsd', () => {
  it('prefers the provider-reported cost over the static price table', () => {
    const cost = resolveCostUsd('some/unlisted-model', { inputTokens: 100, outputTokens: 100, costUsd: 0.0042 })
    expect(cost).toBe(0.0042)
  })

  it('falls back to the static price table when no provider cost is present', () => {
    const cost = resolveCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBeCloseTo(6, 6)
  })

  it('returns null for an unpriced model with no reported cost', () => {
    expect(resolveCostUsd('some/unlisted-model', { inputTokens: 100, outputTokens: 100 })).toBeNull()
  })

  it('returns null for null usage', () => {
    expect(resolveCostUsd('claude-haiku-4-5', null)).toBeNull()
  })
})
