// Attachment and image URLs come straight from crawled upstream pages and
// APIs (see lib/utils.ts: "upstream values, not always app-generated"), so
// any server-side fetch of them is a trust boundary: a hostile or broken
// portal must not be able to point it — directly or via a redirect — at
// localhost, the cloud metadata endpoint or another internal service.

import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'

const MAX_REDIRECTS = 5

function isPublicIp(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'unicast'
}

/** True when `hostname` is, or resolves exclusively to, public unicast IPs. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (ipaddr.isValid(normalized)) return isPublicIp(normalized)
  const records = await lookup(normalized, { all: true, verbatim: true }).catch(() => [])
  return records.length > 0 && records.every((record) => isPublicIp(record.address))
}

/**
 * fetch() for an upstream-supplied URL: only http(s) targets whose host
 * resolves exclusively to public unicast addresses, with every redirect hop
 * re-checked the same way. `data:` URLs never touch the network and pass
 * through. The returned Response's `url` is the final hop, like a followed
 * fetch.
 *
 * ponytail: the host is checked by a lookup before the request, not pinned
 * on the connection, so a DNS answer that changes between check and connect
 * (rebinding) is not covered. Upgrade path: pin the checked address through
 * an undici dispatcher — that needs undici's own fetch, since Node's bundled
 * fetch rejects the newer npm undici Agent ("invalid onRequestStart method").
 */
export async function fetchPublicUrl(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<Response> {
  let current = new URL(url)
  let headers = init.headers
  for (let hop = 0; ; hop++) {
    if (current.protocol === 'data:') return await fetch(current, init)
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`blocked non-http(s) URL: ${current.protocol}`)
    }
    if (!(await isPublicHost(current.hostname))) {
      throw new Error(`blocked non-public host: ${current.hostname}`)
    }
    const res = await fetch(current.toString(), { headers, signal: init.signal, redirect: 'manual' })
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return res
    await res.body?.cancel().catch(() => undefined)
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects for ${url}`)
    const next = new URL(location, current)
    // Same rule a followed fetch applies: credentials (e.g. dga-ag's session
    // cookie) never travel to a different origin.
    if (next.origin !== current.origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !/^(?:cookie|authorization)$/i.test(name)),
      )
    }
    current = next
  }
}

/**
 * The response body as bytes, or null once it exceeds `maxBytes` — checked
 * against Content-Length first, then while streaming, so an oversized body is
 * never buffered whole.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer | null> {
  const contentLength = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > maxBytes ? null : buf
  }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}
