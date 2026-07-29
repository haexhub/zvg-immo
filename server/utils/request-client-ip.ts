import type { H3Event } from 'h3'

/**
 * Resolve the client address for the app's append-style reverse proxy.
 * Client-supplied values can be prepended to X-Forwarded-For, so only the
 * final hop is trusted when forwarded headers are explicitly enabled.
 */
export function requestClientIp(event: H3Event): string {
  const trustForwardedFor = String(useRuntimeConfig().trustForwardedFor ?? '') === '1'
  if (trustForwardedFor) {
    const forwarded = getRequestHeader(event, 'x-forwarded-for')
    const last = forwarded?.split(',').at(-1)?.trim()
    if (last) return last
    const realIp = getRequestHeader(event, 'x-real-ip')?.trim()
    if (realIp) return realIp
  }
  return event.node.req.socket.remoteAddress ?? 'unknown'
}
