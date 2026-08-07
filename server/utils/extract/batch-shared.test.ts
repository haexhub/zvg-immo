import { describe, expect, it } from 'vitest'
import { apiBase, customIdForKey, extractOfetchErrorMessage, isTransientBatchError } from './batch-shared'

describe('extractOfetchErrorMessage', () => {
  it('reads the plain {error:{message}} shape (OpenAI/Anthropic/OpenRouter)', () => {
    expect(extractOfetchErrorMessage({ data: { error: { message: 'Invalid model.' } } })).toBe('Invalid model.')
  })

  it('prefixes the status onto the message for Google\'s {error:{message,status}} shape', () => {
    expect(
      extractOfetchErrorMessage({ data: { error: { message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } } }),
    ).toBe('FAILED_PRECONDITION: Precondition check failed.')
  })

  it('falls back to the generic Error message when the body has no recognizable error shape', () => {
    expect(extractOfetchErrorMessage(new Error('[POST] "...": 400 Bad Request'))).toBe('[POST] "...": 400 Bad Request')
    expect(extractOfetchErrorMessage('not an error object')).toBe('not an error object')
  })
})

describe('isTransientBatchError', () => {
  it('treats 429 and 5xx as transient', () => {
    expect(isTransientBatchError({ status: 429 })).toBe(true)
    expect(isTransientBatchError({ statusCode: 503 })).toBe(true)
    expect(isTransientBatchError({ response: { status: 500 } })).toBe(true)
  })

  it('treats abort/timeout and known connection error codes as transient', () => {
    expect(isTransientBatchError(Object.assign(new Error('timed out'), { name: 'AbortError' }))).toBe(true)
    expect(isTransientBatchError(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientBatchError(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))).toBe(true)
  })

  it('treats a 4xx (durable rejection) as not transient', () => {
    expect(isTransientBatchError({ status: 400 })).toBe(false)
    expect(isTransientBatchError(new Error('model: field required'))).toBe(false)
  })
})

describe('customIdForKey', () => {
  it('is deterministic for the same key/index and differs across keys/indices', () => {
    expect(customIdForKey('zvg-portal:7265', 0)).toBe(customIdForKey('zvg-portal:7265', 0))
    expect(customIdForKey('zvg-portal:7265', 0)).not.toBe(customIdForKey('zvg-portal:7265', 1))
    expect(customIdForKey('zvg-portal:7265', 0)).not.toBe(customIdForKey('zvg-portal:9999', 0))
  })

  it('stays within the 64-char id limit most batch APIs impose', () => {
    expect(customIdForKey('zvg-portal:7265', 12345).length).toBeLessThanOrEqual(64)
  })
})

describe('apiBase', () => {
  it('strips a single trailing slash', () => {
    expect(apiBase({ baseUrl: 'https://api.openai.com/v1/', model: 'x' })).toBe('https://api.openai.com/v1')
    expect(apiBase({ baseUrl: 'https://api.openai.com/v1', model: 'x' })).toBe('https://api.openai.com/v1')
  })
})
