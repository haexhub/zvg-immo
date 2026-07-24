import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadNativeImages } from './native-images'

// Minimal valid JPEG/PNG/WebP magic-byte prefixes. Real bodies would be longer
// but downloadNativeImages only inspects the first bytes to reject non-images.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// WebP RIFF container: 'RIFF' at 0-3, 4-byte little-endian size, 'WEBP' at 8-11.
const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

function makeImage(magic: Buffer, extraByte: number): Buffer {
  // Pad to >= 512 bytes so the min-size filter still passes. The extra byte
  // varies per call so different callers produce distinct hashes.
  return Buffer.concat([magic, Buffer.alloc(1024, extraByte)])
}

interface FakeResponse {
  ok: boolean
  status?: number
  body: Buffer | null
  contentType?: string
}

function stubFetch(responsesByUrl: Record<string, FakeResponse | (() => FakeResponse)>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const entry = responsesByUrl[url]
      if (!entry) throw new Error(`unstubbed URL: ${url}`)
      const resolved = typeof entry === 'function' ? entry() : entry
      const arrayBuffer = async () => {
        if (!resolved.body) throw new Error('no body')
        return resolved.body.buffer.slice(
          resolved.body.byteOffset,
          resolved.body.byteOffset + resolved.body.byteLength,
        )
      }
      return {
        ok: resolved.ok,
        status: resolved.status ?? (resolved.ok ? 200 : 500),
        headers: new Headers({ 'content-type': resolved.contentType ?? 'image/jpeg' }),
        arrayBuffer,
      } as unknown as Response
    }),
  )
}

describe('downloadNativeImages', () => {
  let destDir: string

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), 'native-images-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(destDir, { recursive: true, force: true })
  })

  it('downloads JPEG + PNG and writes content-addressable filenames', async () => {
    const jpg = makeImage(JPEG_MAGIC, 1)
    const png = makeImage(PNG_MAGIC, 2)
    stubFetch({
      'https://example.com/a.jpg': { ok: true, body: jpg, contentType: 'image/jpeg' },
      'https://example.com/b.png': { ok: true, body: png, contentType: 'image/png' },
    })

    const files = await downloadNativeImages(
      ['https://example.com/a.jpg', 'https://example.com/b.png'],
      { destDir },
    )

    expect(files).toHaveLength(2)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.jpg$/)
    expect(files[1]).toMatch(/^[0-9a-f]{16}\.png$/)
    const written = await readdir(destDir)
    expect(written.sort()).toEqual([...files].sort())
  })

  it('downloads WebP and writes with .webp extension', async () => {
    const webp = makeImage(WEBP_MAGIC, 7)
    stubFetch({
      'https://example.com/pic.webp': { ok: true, body: webp, contentType: 'image/webp' },
    })
    const files = await downloadNativeImages(['https://example.com/pic.webp'], { destDir })
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.webp$/)
  })

  it('skips URLs whose response body is not an image', async () => {
    const jpg = makeImage(JPEG_MAGIC, 3)
    const html = Buffer.from('<!doctype html><html>oops</html>')
    stubFetch({
      'https://example.com/ok.jpg': { ok: true, body: jpg, contentType: 'image/jpeg' },
      'https://example.com/bad.jpg': { ok: true, body: html, contentType: 'text/html' },
    })

    const files = await downloadNativeImages(
      ['https://example.com/bad.jpg', 'https://example.com/ok.jpg'],
      { destDir },
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.jpg$/)
  })

  it('skips non-OK responses', async () => {
    stubFetch({
      'https://example.com/gone.jpg': { ok: false, status: 404, body: null },
      'https://example.com/ok.jpg': { ok: true, body: makeImage(JPEG_MAGIC, 4), contentType: 'image/jpeg' },
    })

    const files = await downloadNativeImages(
      ['https://example.com/gone.jpg', 'https://example.com/ok.jpg'],
      { destDir },
    )
    expect(files).toHaveLength(1)
  })

  it('treats transient HTTP statuses (408/429/5xx) as retryable failures', async () => {
    // Unlike a stable 404/403, these should surface as a thrown error (via
    // hadFetchError) rather than a silent "no image here" so the enrich
    // task's photoFailures/photosCheckedAt tracking sees it as unresolved.
    stubFetch({
      'https://example.com/rate-limited.jpg': { ok: false, status: 429, body: null },
    })

    await expect(
      downloadNativeImages(['https://example.com/rate-limited.jpg'], { destDir }),
    ).rejects.toThrow(/network error/)
  })

  it('still treats a stable 404 as a confirmed empty result, not retryable', async () => {
    stubFetch({
      'https://example.com/gone-for-good.jpg': { ok: false, status: 404, body: null },
    })

    const files = await downloadNativeImages(['https://example.com/gone-for-good.jpg'], { destDir })
    expect(files).toEqual([])
  })

  it('dedupes identical bytes to one file', async () => {
    const same = makeImage(JPEG_MAGIC, 5)
    stubFetch({
      'https://example.com/x.jpg': { ok: true, body: same, contentType: 'image/jpeg' },
      'https://example.com/y.jpg': { ok: true, body: same, contentType: 'image/jpeg' },
    })

    const files = await downloadNativeImages(
      ['https://example.com/x.jpg', 'https://example.com/y.jpg'],
      { destDir },
    )
    expect(files).toHaveLength(1)
  })

  it('is idempotent across re-runs: same URL → same filename', async () => {
    // Same URL yielding same bytes should produce the same content-addressable
    // filename each time — safe to re-run the enrich task without churning
    // filenames or accumulating duplicates on disk.
    const jpg = makeImage(JPEG_MAGIC, 6)
    const url = 'https://example.com/reuse.jpg'
    stubFetch({ [url]: { ok: true, body: jpg, contentType: 'image/jpeg' } })
    const first = await downloadNativeImages([url], { destDir })
    expect(first).toHaveLength(1)
    const again = await downloadNativeImages([url], { destDir })
    expect(again).toEqual(first)
    const onDisk = await readdir(destDir)
    expect(onDisk).toEqual(first)
  })

  it('caps output at maxImages', async () => {
    const responses: Record<string, FakeResponse> = {}
    const urls: string[] = []
    for (let i = 0; i < 20; i++) {
      const u = `https://example.com/${i}.jpg`
      urls.push(u)
      responses[u] = { ok: true, body: makeImage(JPEG_MAGIC, i + 10), contentType: 'image/jpeg' }
    }
    stubFetch(responses)
    const files = await downloadNativeImages(urls, { destDir, maxImages: 5 })
    expect(files).toHaveLength(5)
  })

  it('counts successes against maxImages, not attempts', async () => {
    // Dead URLs at the front must not eat into the cap: with maxImages 2 and
    // the first three URLs failing, both later valid URLs still get written.
    const responses: Record<string, FakeResponse> = {}
    const urls: string[] = []
    for (let i = 0; i < 3; i++) {
      const u = `https://example.com/dead-${i}.jpg`
      urls.push(u)
      responses[u] = { ok: false, status: 404, body: null }
    }
    for (let i = 0; i < 2; i++) {
      const u = `https://example.com/live-${i}.jpg`
      urls.push(u)
      responses[u] = { ok: true, body: makeImage(JPEG_MAGIC, i + 40), contentType: 'image/jpeg' }
    }
    stubFetch(responses)
    const files = await downloadNativeImages(urls, { destDir, maxImages: 2 })
    expect(files).toHaveLength(2)
  })
})
