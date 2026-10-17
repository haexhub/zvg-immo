import { describe, expect, it } from 'vitest'
import { LlmProviderError, isConnectionDroppedError, isConnectionLostError } from './llm-errors'

/** Creates the undici-style error shape returned by a failed fetch. */
const fetchFailed = (code: string) => Object.assign(
  new TypeError('[POST] "http://proxy:8080/v1/messages": <no response> fetch failed'),
  { cause: { code, message: 'x' } },
)

describe('isConnectionLostError', () => {
  it('recognises a refused or reset connection, also inside the provider wrapper', () => {
    expect(isConnectionLostError(fetchFailed('ECONNREFUSED'))).toBe(true)
    expect(isConnectionLostError(fetchFailed('ECONNRESET'))).toBe(true)
    expect(isConnectionLostError(new LlmProviderError('claude-proxy', 'x', { cause: fetchFailed('UND_ERR_SOCKET') }))).toBe(true)
  })

  it('does not treat an HTTP error status or a client timeout as a lost connection', () => {
    expect(isConnectionLostError(Object.assign(new Error('http 500'), { response: { status: 500 } }))).toBe(false)
    expect(isConnectionLostError(Object.assign(new Error('<no response> The operation was aborted due to timeout'), { cause: { name: 'TimeoutError' } }))).toBe(false)
  })

  it('is broader than the retry check: a reset is lost, but never safe to re-send', () => {
    expect(isConnectionLostError(fetchFailed('ECONNRESET'))).toBe(true)
    expect(isConnectionDroppedError(fetchFailed('ECONNRESET'))).toBe(false)
    expect(isConnectionDroppedError(fetchFailed('ECONNREFUSED'))).toBe(true)
  })
})
