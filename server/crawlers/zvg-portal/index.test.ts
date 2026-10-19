import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zvgPortalCrawler } from './index'

const row = (id: number) =>
  `<!--Aktenzeichen---><TR><TD>Aktenzeichen</td><td><strong><a href=index.php?button=showZvg&zvg_id=${id}&land_abk=sn>` +
  `<nobr>0525 K 0${id}/2026&nbsp;(Detailansicht)</nobr></a></strong></td></tr>`
const resultPage = (announced: number | null, ids: number[]) =>
  `<html><body>${announced == null ? '' : `Alle Termine, Insgesamt ${announced}`}<table>${ids.map(row).join('')}</table></body></html>`

const crawlSachsen = () => zvgPortalCrawler.crawl({ region: 'sn', enrichDetails: false })

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('zvg-portal crawl', () => {
  it('reports a complete crawl when every announced row arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(resultPage(2, [1, 2]))))

    const result = await crawlSachsen()

    expect(result.auctions.map((a) => a.externalId)).toEqual(['1', '2'])
    expect(result.platformsSucceeded).toEqual(['zvg-portal'])
  })

  it('accepts a real empty result page ("Insgesamt 0") as a successful zero-result crawl', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(resultPage(0, []))))

    const result = await crawlSachsen()

    expect(result.auctions).toEqual([])
    expect(result.platformsSucceeded).toEqual(['zvg-portal'])
  })

  it('fails instead of reporting an empty Land when the page has neither marker nor rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>Wartungsarbeiten</body></html>')))

    await expect(crawlSachsen()).rejects.toThrow(/not a result page/)
  })

  it('fails on the bare `error` body after retrying it', async () => {
    const fetchMock = vi.fn(async () => new Response('error'))
    vi.stubGlobal('fetch', fetchMock)

    const pending = crawlSachsen().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await pending).toMatchObject({ message: expect.stringContaining('returned error page') })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the rows of a truncated response but withholds success', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(resultPage(3, [1]))))

    const result = await crawlSachsen()

    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })
})
