import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLawyerInput } from './lawyer-input'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseLawyerInput', () => {
  it('parses a full valid body', () => {
    vi.stubGlobal('createError', (input: unknown) => new Error(JSON.stringify(input)))
    const result = parseLawyerInput({
      name: '  Jane Doe  ',
      email: ' jane@example.com ',
      countries: ['DE', ' se '],
      firm: '  Doe & Partners  ',
      phone: '+49 30 000000',
      specialization: 'Zwangsversteigerung',
      languages: ['de', 'en'],
      website: 'https://example.com',
      commissionCents: 12345.6,
      active: true,
    })

    expect(result).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      countries: ['de', 'se'],
      firm: 'Doe & Partners',
      phone: '+49 30 000000',
      specialization: 'Zwangsversteigerung',
      languages: ['de', 'en'],
      website: 'https://example.com',
      commissionCents: 12346,
      active: true,
    })
  })

  it('defaults active to true unless explicitly false', () => {
    vi.stubGlobal('createError', (input: unknown) => new Error(JSON.stringify(input)))
    const active = parseLawyerInput({ name: 'A', email: 'a@example.com', countries: ['de'] })
    expect(active.active).toBe(true)

    const inactive = parseLawyerInput({ name: 'A', email: 'a@example.com', countries: ['de'], active: false })
    expect(inactive.active).toBe(false)
  })

  it('coerces optional fields to null when blank/missing', () => {
    vi.stubGlobal('createError', (input: unknown) => new Error(JSON.stringify(input)))
    const result = parseLawyerInput({
      name: 'A',
      email: 'a@example.com',
      countries: ['de'],
      firm: '   ',
      phone: '',
      specialization: undefined,
      languages: [],
      website: null,
      commissionCents: 'not-a-number',
    })

    expect(result.firm).toBeNull()
    expect(result.phone).toBeNull()
    expect(result.specialization).toBeNull()
    expect(result.languages).toBeNull()
    expect(result.website).toBeNull()
    expect(result.commissionCents).toBeNull()
  })

  it.each([
    ['name', { email: 'a@example.com', countries: ['de'] }],
    ['email', { name: 'A', countries: ['de'] }],
    ['countries', { name: 'A', email: 'a@example.com', countries: [] }],
  ])('throws a 400 when %s is missing', (_label, body) => {
    const createError = vi.fn((input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('createError', createError)

    expect(() => parseLawyerInput(body)).toThrow()
    expect(createError).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
  })
})
