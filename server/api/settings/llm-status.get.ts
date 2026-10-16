import { iterateAuctionRecords } from '~/server/utils/auction-record'
import { classifyLlmStatus, isLlmExtractionInScope } from '~/server/utils/llm-status'

export interface LlmStatusCounts {
  done: number
  error: number
  open: number
  pending: number
  total: number
}

export default defineEventHandler(async (): Promise<Record<string, LlmStatusCounts>> => {
  const out: Record<string, LlmStatusCounts> = {}
  // Streamed: the page polls this, and materializing every auction per poll cost ~300 MB each time.
  for await (const record of iterateAuctionRecords(undefined, { includePhotos: false })) {
    if (!isLlmExtractionInScope(record)) continue
    const counts = out[record.auction.country] ?? (out[record.auction.country] = { done: 0, error: 0, open: 0, pending: 0, total: 0 })
    counts[classifyLlmStatus(record)]++
    counts.total++
  }
  return out
})
