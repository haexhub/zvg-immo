import { describe, expect, it } from 'vitest'
import {
  apiBase,
  customIdForKey,
  extractBatchFailureReason,
  extractBatchItemErrorMessage,
  extractOfetchErrorMessage,
  isTransientBatchError,
  pendingOnTransientPollError,
} from './batch-shared'

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

describe('extractBatchItemErrorMessage', () => {
  it('prefers an explicit top-level error message', () => {
    expect(extractBatchItemErrorMessage({ message: 'rate limited' }, { status_code: 200 })).toBe('rate limited')
  })

  it('falls back to the response body\'s own error message on a non-200 status', () => {
    expect(extractBatchItemErrorMessage(null, { status_code: 400, body: { error: { message: 'bad request' } } })).toBe('bad request')
  })

  it('falls back to a bare HTTP status when the body has no message', () => {
    expect(extractBatchItemErrorMessage(null, { status_code: 500, body: null })).toBe('HTTP 500')
  })

  it('returns null when there is nothing to report (a genuine 200 with no error)', () => {
    expect(extractBatchItemErrorMessage(null, { status_code: 200, body: {} })).toBeNull()
    expect(extractBatchItemErrorMessage(undefined, undefined)).toBeNull()
  })
})

describe('apiBase', () => {
  it('strips a single trailing slash', () => {
    expect(apiBase({ baseUrl: 'https://api.openai.com/v1/', model: 'x' })).toBe('https://api.openai.com/v1')
    expect(apiBase({ baseUrl: 'https://api.openai.com/v1', model: 'x' })).toBe('https://api.openai.com/v1')
  })
})

describe('pendingOnTransientPollError', () => {
  const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { response: { status } })

  it('keeps the job pending for network errors, timeouts, 408/429 and 5xx', () => {
    for (const err of [new Error('fetch failed'), httpError(408), httpError(429), httpError(500), httpError(503)]) {
      expect(pendingOnTransientPollError(err, 'test-batch', 'job')).toEqual({ state: 'pending' })
    }
  })

  it('rethrows a durable 4xx with the provider message so the poller can give the job up', () => {
    const err = Object.assign(httpError(401), { data: { error: { message: 'invalid api key' } } })
    expect(() => pendingOnTransientPollError(err, 'test-batch', 'job')).toThrow('invalid api key')
    expect(() => pendingOnTransientPollError(httpError(402), 'test-batch', 'job')).toThrow('http 402')
    expect(() => pendingOnTransientPollError(httpError(404), 'test-batch', 'job')).toThrow('http 404')
  })
})

describe('extractBatchFailureReason', () => {
  it('reads error as a string or {message}, then the first usable errors entry', () => {
    expect(extractBatchFailureReason({ error: 'quota' })).toBe('quota')
    expect(extractBatchFailureReason({ error: { message: 'boom' } })).toBe('boom')
    expect(extractBatchFailureReason({ errors: ['', { message: 'second' }] })).toBe('second')
    expect(extractBatchFailureReason({ errors: { data: [{ message: 'openai style' }] } })).toBe('openai style')
  })

  it('returns undefined when the provider reports no reason', () => {
    expect(extractBatchFailureReason({ status: 'failed' })).toBeUndefined()
    expect(extractBatchFailureReason({ error: null, errors: null })).toBeUndefined()
    expect(extractBatchFailureReason(null)).toBeUndefined()
  })
})
