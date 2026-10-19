import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { zvgPortalCrawler } from './index'

vi.mock('~/server/utils/fetch-archive', () => ({ archiveDetailCapture: vi.fn() }))

const auction = {
  platform: 'zvg-portal',
  externalId: '40685',
  detailUrlUpstream: 'https://www.zvg-portal.de/index.php?button=showZvg&zvg_id=40685&land_abk=sn',
  attachments: [],
} as unknown as Auction

const DETAIL_HTML = '<html><body><table><tr><td>Beschreibung:</td><td>Einfamilienhaus mit Garten</td></tr></table></body></html>'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('zvg-portal enrichOne', () => {
  it('retries a dropped connection and the bare `error` body the portal sends under load', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(new Response('error'))
      .mockResolvedValueOnce(new Response(DETAIL_HTML))
    vi.stubGlobal('fetch', fetchMock)
    const target = { ...auction }

    const done = zvgPortalCrawler.enrichOne!(target)
    await vi.advanceTimersByTimeAsync(5_000)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(target.description).toBe('Einfamilienhaus mit Garten')
  })

  it('surfaces the real failure reason instead of a bare "detail fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }) }))

    const done = zvgPortalCrawler.enrichOne!({ ...auction }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await done).toMatchObject({ message: expect.stringContaining('fetch failed (ETIMEDOUT)') })
  })

  it('does not retry a 4xx', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const done = zvgPortalCrawler.enrichOne!({ ...auction }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await done).toMatchObject({ message: expect.stringContaining('HTTP 404') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
