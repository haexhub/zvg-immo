export type AuctionKeySource = {
  platform: string
  externalId: string
}

export function auctionKey(a: AuctionKeySource): string {
  return `${a.platform}:${a.externalId}`
}
