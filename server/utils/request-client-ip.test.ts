import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { requestClientIp } from './request-client-ip'

function makeEvent(headers: Record<string, string>, remoteAddress = '10.0.0.9'): H3Event {
  vi.stubGlobal('getRequestHeader', (_event: unknown, name: string) => headers[name])
  return { node: { req: { socket: { remoteAddress } } } } as unknown as H3Event
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestClientIp', () => {
  it('uses the last x-forwarded-for entry (the one the trusted proxy appended) when trusted', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustForwardedFor: '1' }))
    expect(requestClientIp(makeEvent({ 'x-forwarded-for': 'spoofed, 10.0.0.1' }))).toBe('10.0.0.1')
  })

  it('falls back to x-real-ip when trusted and x-forwarded-for is empty', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustForwardedFor: '1' }))
    expect(requestClientIp(makeEvent({ 'x-forwarded-for': ' ', 'x-real-ip': '192.0.2.4' }))).toBe('192.0.2.4')
  })

  it('ignores forwarded headers and uses the socket address when not trusted', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustForwardedFor: '0' }))
    expect(requestClientIp(makeEvent({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '192.0.2.4' }))).toBe('10.0.0.9')
  })
})
