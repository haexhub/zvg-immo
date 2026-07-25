// Polls in-flight Gemini Batch API jobs (submitted by enrich.ts/reprocess.ts,
// see server/utils/extract/gemini-batch.ts) and merges completed results into
// extraction_cache/auction_snapshot — the async counterpart to those tasks'
// synchronous LLM merge (server/utils/extract/merge-llm-result.ts). Scheduled
// every 30 minutes (nuxt.config.ts) plus a boot-time nudge (llm-batch-poll-
// bootstrap.ts) so a job that finished while the server was down/restarting
// gets merged promptly instead of waiting for the next tick.

import type { Auction, AuctionExtraction } from '~/types/auction'
import { fetchGeminiBatchResults, pollGeminiBatch } from '../utils/extract/gemini-batch'
import { type LlmConfig } from '../utils/extract/llm'
import { mergeLlmResult, type MergeInputFields } from '../utils/extract/merge-llm-result'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
  type ExtractionCache,
} from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { deleteLlmBatchJob, listPendingLlmBatchJobs } from '../utils/llm-batch-jobs'

function readLlmConfig(): LlmConfig | null {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  if (!c?.baseUrl) return null
  const provider = c.provider === 'claude-proxy' || c.provider === 'gemini-native' ? c.provider : 'openai-compatible'
  return {
    provider,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey || undefined,
    model: c.model || (provider === 'gemini-native' ? 'gemini-flash-latest' : 'claude-haiku-4-5'),
  }
}

function splitKey(key: string): { platform: string; externalId: string } | null {
  const i = key.indexOf(':')
  if (i < 0) return null
  return { platform: key.slice(0, i), externalId: key.slice(i + 1) }
}

// Reconstructs the `MergeInputFields` mergeLlmResult needs from the
// already-cached rules-only entry (written at submit time by enrich.ts/
// reprocess.ts). `confident` (whether the LLM may still touch propertyType/
// sizes) is provably `confidence === 'high'`: extractByRules defines
// `confident` as "a real property type and an area", the exact same
// condition both callers' `confidence: 'high'` is derived from — so the
// original `rules.confident || (hasType && hasArea)` gate always reduces to
// `confidence === 'high'`, without needing the original (unpersisted)
// `rules.confident` flag.
function toMergeFields(entry: AuctionExtraction): MergeInputFields {
  return {
    propertyType: entry.propertyType,
    landAreaSqm: entry.landAreaSqm,
    livingAreaSqm: entry.livingAreaSqm,
    rooms: entry.rooms,
    units: entry.units,
    securityDeposit: entry.securityDeposit ?? null,
    condition: entry.condition,
    features: entry.features,
    yearBuilt: entry.yearBuilt,
    lastRenovationYear: entry.lastRenovationYear,
    renovationNotes: entry.renovationNotes,
    insights: entry.insights,
    planningNotes: entry.planningNotes,
    documentSummary: entry.documentSummary,
    marketValueEur: entry.marketValueEur,
    marketValueText: entry.marketValueText,
    confident: entry.confidence === 'high',
  }
}

export default defineTask({
  meta: {
    name: 'llm-batch-poll',
    description: 'Poll in-flight Gemini Batch API jobs and merge completed results into extraction_cache/auction_snapshot.',
  },
  async run() {
    return { result: await runLlmBatchPoll() }
  },
})

export async function runLlmBatchPoll(): Promise<{ checked: number; merged: number }> {
  const jobs = await listPendingLlmBatchJobs()
  if (jobs.length === 0) return { checked: 0, merged: 0 }

  const llmConfig = readLlmConfig()
  if (!llmConfig) {
    console.warn('[llm-batch-poll] pending jobs exist but no LLM provider is configured — skipping')
    return { checked: 0, merged: 0 }
  }

  const cache = await readExtractionCache()
  const at = new Date().toISOString()
  let merged = 0

  for (const job of jobs) {
    try {
      const poll = await pollGeminiBatch(job.jobName, llmConfig)
      if (poll.state === 'pending') continue

      if (poll.state === 'failed' || poll.state === 'expired') {
        // Affected items keep their (now-orphaned) llmBatchJob marker — no
        // extra code needed, isLlmBatchPending's 48h age check makes them
        // eligible again on its own once this deleted job would have expired.
        await deleteLlmBatchJob(job.jobName)
        console.warn(`[llm-batch-poll] job ${job.jobName} ${poll.state}`)
        continue
      }

      const results = await fetchGeminiBatchResults(poll.resultFileName!, llmConfig)
      const dirty: ExtractionCache = {}
      const snapshot = await readAuctionSnapshot()
      const snapshotUpdates: Auction[] = []

      for (const { key, extraction } of results) {
        if (!splitKey(key)) continue
        const priorEntry = cache[key]
        if (!priorEntry) continue
        // mergeLlmResult's return type has no `llmBatchJob` field, so the
        // marker is dropped here simply by not carrying it forward.
        const mergedEntry = mergeLlmResult(priorEntry, toMergeFields(priorEntry), extraction, at, priorEntry.photos)
        cache[key] = mergedEntry
        dirty[key] = mergedEntry
        merged++

        const snapshotEntry = snapshot[key]
        if (snapshotEntry) {
          const updated: Auction = { ...snapshotEntry }
          applyExtractionToAuctions([updated], { [key]: mergedEntry })
          snapshotUpdates.push(updated)
        }
      }

      const cacheWritten = Object.keys(dirty).length === 0 || (await writeExtractionCache(dirty))
      if (!cacheWritten) {
        console.warn(`[llm-batch-poll] cache write failed for job ${job.jobName} — leaving job for next tick`)
        continue
      }
      if (snapshotUpdates.length > 0) await writeAuctionSnapshot(snapshotUpdates)
      await deleteLlmBatchJob(job.jobName)
      console.log(`[llm-batch-poll] job ${job.jobName} succeeded — merged ${results.length} items`)
    } catch (err) {
      console.warn(`[llm-batch-poll] failed for job ${job.jobName}: ${(err as Error).message}`)
    }
  }

  return { checked: jobs.length, merged }
}
