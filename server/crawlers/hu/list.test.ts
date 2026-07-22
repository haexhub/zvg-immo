import { describe, expect, it } from 'vitest'
import { parsePage } from './list'

/** Single MNV listing row, matching the real column layout documented in
 *  list.ts (11 <td> cells, row identified by img.colAuctionImage). */
function makeRow({
  auctionId = '48407',
  price = '3 900 000',
  date = '2026.07.27. 21:00',
}: { auctionId?: string; price?: string; date?: string } = {}): string {
  return `
<table><tr>
  <td><img class="colAuctionImage" src="pictures/thumb.jpg"></td>
  <td><a href="index-meghirdetesek-ingatlan.html?.actionId=action.auction.AuctionSummaryAction&amp;auctionId=${auctionId}">Beépitetlen terület</a></td>
  <td>49866/260702</td>
  <td><a>Révleányvár</a></td>
  <td>1/1</td>
  <td><input type="checkbox"></td>
  <td>${price}</td>
  <td>390 000</td>
  <td></td>
  <td>2026.07.13. 21:00</td>
  <td>${date}</td>
</tr></table>`
}

describe('parsePage', () => {
  it('maps the reserve-price column to both marketValue and startingBid', () => {
    const { auctions } = parsePage(makeRow(), 'hu-mnv')
    expect(auctions).toHaveLength(1)
    const a = auctions[0]!
    expect(a.marketValue).toBe(3_900_000)
    expect(a.currency).toBe('HUF')
    expect(a.startingBid).toBe(3_900_000)
  })

  it('leaves marketValue, currency and startingBid null when the price cell is empty', () => {
    const { auctions } = parsePage(makeRow({ price: '' }), 'hu-mnv')
    const a = auctions[0]!
    expect(a.marketValue).toBeNull()
    expect(a.currency).toBeNull()
    expect(a.startingBid).toBeNull()
  })
})
