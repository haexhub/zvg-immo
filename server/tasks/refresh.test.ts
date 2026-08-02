import { afterEach, describe, expect, it, vi } from 'vitest'
import { crawlSingle, listRegions } from '../crawlers/registry'
import { regionListCacheAgeMs } from '../utils/list-cache'
import { drainOutbox } from '../utils/storage-uploader'

vi.mock('../crawlers/registry', () => ({
  crawlSingle: vi.fn(),
  listRegions: vi.fn(),
  ensureEnabledCountriesLoaded: vi.fn(async () => []),
}))
vi.mock('../crawlers/crawl-cadence', () => ({ regionRefreshIntervalMs: vi.fn(() => 3_600_000) }))
vi.mock('../utils/alert-matching', () => ({ matchAlerts: vi.fn() }))
vi.mock('../utils/history', () => ({ recordObservations: vi.fn() }))
vi.mock('../utils/raw-archive', () => ({ archiveAuction: vi.fn() }))
vi.mock('../utils/current-auctions', () => ({ ensureAuctionIdentity: vi.fn() }))
vi.mock('../utils/auction-fetch-state', () => ({ writeAuctionCrawlFetchState: vi.fn() }))
vi.mock('../utils/list-cache', () => ({
  regionListCacheAgeMs: vi.fn(async () => null),
  writeListCache: vi.fn(),
}))
vi.mock('../utils/storage-uploader', () => ({ drainOutbox: vi.fn(async () => ({ uploaded: 0, failed: 0 })) }))

// defineTask is a Nitro auto-import — same stubbing pattern as enrich.test.ts.
vi.stubGlobal('defineTask', (def: unknown) => def)

function region(country: string, code: string) {
  return { country, code, platforms: [{ id: `${country}-portal`, name: code }] }
}

async function loadTask() {
  const mod = await import('./refresh')
  return (mod.default as unknown as { run: () => Promise<{ result: { ok: number; failed: number } }> })
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('refresh failure reporting', () => {
  it('reports a partial failure in the result instead of failing the whole run', async () => {
    // Individual portals fail routinely (captcha, upstream 429). Throwing here
    // would mark practically every hourly run as failed.
    vi.mocked(listRegions).mockReturnValue([region('de', 'by'), region('de', 'he')] as never)
    vi.mocked(crawlSingle)
      .mockResolvedValueOnce({ auctions: [] } as never)
      .mockRejectedValueOnce(new Error('captcha'))
    const task = await loadTask()

    const outcome = await task.run()

    expect(outcome.result).toMatchObject({ ok: 1, failed: 1 })
  })

  it('fails the run when no region could be crawled at all', async () => {
    vi.mocked(listRegions).mockReturnValue([region('de', 'by'), region('de', 'he')] as never)
    vi.mocked(crawlSingle).mockRejectedValue(new Error('upstream down'))
    const task = await loadTask()

    await expect(task.run()).rejects.toThrow('Refresh komplett fehlgeschlagen')
  })

  it('does not fail the run for an archive upload failure alone', async () => {
    vi.mocked(listRegions).mockReturnValue([region('de', 'by')] as never)
    vi.mocked(crawlSingle).mockResolvedValue({ auctions: [] } as never)
    vi.mocked(drainOutbox).mockResolvedValue({ uploaded: 0, failed: 3 } as never)
    const task = await loadTask()

    const outcome = await task.run()

    expect(outcome.result).toMatchObject({ ok: 1, failed: 0 })
  })

  it('skips a region whose list cache is still within its refresh interval', async () => {
    vi.mocked(listRegions).mockReturnValue([region('de', 'by')] as never)
    vi.mocked(regionListCacheAgeMs).mockResolvedValue(60_000)
    const task = await loadTask()

    const outcome = await task.run()

    expect(outcome.result).toMatchObject({ ok: 0, failed: 0, skipped: 1 })
    expect(crawlSingle).not.toHaveBeenCalled()
  })
})
