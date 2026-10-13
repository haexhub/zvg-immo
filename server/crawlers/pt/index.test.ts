import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from 'undici'
import type { Auction } from '~/types/auction'
import { eLeiloesCrawler } from './index'
import { PT_BASE } from './constants'

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}))

describe('eLeiloesCrawler.enrichOne', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset()
  })

  it('keys the detail fetch on the referencia from the detail URL, not on the enriched case number', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ item: { processoNumero: '1201/11.1TBCTB', processoTribunal: 'C.Branco - JC Cível - Juiz 2' } }) as never,
    )
    const auction = {
      caseNumber: '1201/11.1TBCTB',
      authority: 'C.Branco - JC Cível - Juiz 2',
      detailUrlUpstream: `${PT_BASE}/evento/NP1201552026`,
    } as Auction
    await eLeiloesCrawler.enrichOne!(auction)
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toMatch(/\/NP1201552026$/)
    expect(auction.caseNumber).toBe('1201/11.1TBCTB')
  })
})
