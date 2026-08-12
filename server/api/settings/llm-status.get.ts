import { readAuctionRecords } from '~/server/utils/auction-record'
import { classifyLlmStatus } from '~/server/utils/llm-status'

export interface LlmStatusCounts {
  done: number
  error: number
  open: number
  pending: number
  total: number
}

export default defineEventHandler(async (): Promise<Record<string, LlmStatusCounts>> => {
  const records = await readAuctionRecords(undefined, { includePhotos: false })
  const out: Record<string, LlmStatusCounts> = {}
  for (const record of records) {
    const counts = out[record.auction.country] ?? (out[record.auction.country] = { done: 0, error: 0, open: 0, pending: 0, total: 0 })
    counts[classifyLlmStatus(record)]++
    counts.total++
  }
  return out
})
