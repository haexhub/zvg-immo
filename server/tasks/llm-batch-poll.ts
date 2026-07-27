// Polls in-flight LLM Batch API jobs (submitted by enrich.ts/reprocess.ts,
// see server/utils/extract/llm-batch.ts) and merges completed results into
// extraction_cache/auction_snapshot — the async counterpart to those tasks'
// synchronous LLM merge (server/utils/extract/merge-llm-result.ts). Scheduled
// every 30 minutes (nuxt.config.ts) plus a boot-time nudge (llm-batch-poll-
// bootstrap.ts) so a job that finished while the server was down/restarting
// gets merged promptly instead of waiting for the next tick.

import type { Auction, AuctionExtraction } from '~/types/auction'
import { fetchLlmBatchResults, pollLlmBatch } from '../utils/extract/llm-batch'
import { resolveLlmConfig, type LlmConfig } from '../utils/extract/llm'
import { mergeLlmResult, type MergeInputFields } from '../utils/extract/merge-llm-result'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
  type ExtractionCache,
} from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import {
  listPendingLlmBatchJobs,
  markLlmBatchJobChecked,
  markLlmBatchJobResolved,
  type LlmBatchJob,
} from '../utils/llm-batch-jobs'
import { getPool } from '../utils/db'
import { getLlmProviderOverride } from '../utils/app-settings'

const DEFAULT_GEMINI_FREE_BATCH_POLL_INTERVAL_HOURS = 6

async function readLlmConfig(): Promise<LlmConfig | null> {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const db = getPool()
  const override = db ? await getLlmProviderOverride(db, 'extraction').catch(() => null) : null
  return resolveLlmConfig(override ?? c)
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const raw = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function readGeminiBatchPollIntervalMs(): number {
  const c = useRuntimeConfig().extractLlm as
    | { geminiBatchTier?: string; geminiFreeBatchPollIntervalHours?: string | number }
    | undefined
  if (c?.geminiBatchTier === 'paid') return 0
  return Math.round(
    parsePositiveNumber(
      c?.geminiFreeBatchPollIntervalHours,
      DEFAULT_GEMINI_FREE_BATCH_POLL_INTERVAL_HOURS,
    ) * 60 * 60 * 1000,
  )
}

function isGeminiBatchJob(jobName: string): boolean {
  return jobName.startsWith('batches/')
}

function shouldSkipGeminiFreePoll(job: LlmBatchJob, now: number): boolean {
  if (!isGeminiBatchJob(job.jobName)) return false
  const intervalMs = readGeminiBatchPollIntervalMs()
  if (intervalMs <= 0 || !job.checkedAt) return false
  const checkedAt = Date.parse(job.checkedAt)
  return Number.isFinite(checkedAt) && now - checkedAt < intervalMs
}

function splitKey(key: string): { platform: string; externalId: string } | null {
  const i = key.indexOf(':')
  if (i < 0) return null
  return { platform: key.slice(0, i), externalId: key.slice(i + 1) }
}

// Reconstructs the `MergeInputFields` mergeLlmResult needs from the
// already-cached rules-only entry (written at explicit batch-submit time by
// enrich.ts/reprocess.ts). `confident` (whether the LLM may still touch propertyType/
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
    bedrooms: entry.bedrooms,
    bathrooms: entry.bathrooms,
    floor: entry.floor,
    bathroomHasTub: entry.bathroomHasTub,
    bathroomHasShower: entry.bathroomHasShower,
    heating: entry.heating,
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
    description: 'Poll in-flight LLM Batch API jobs and merge completed results into extraction_cache/auction_snapshot.',
  },
  async run() {
    return { result: await runLlmBatchPoll() }
  },
})

export async function runLlmBatchPoll(): Promise<{ checked: number; merged: number }> {
  const jobs = await listPendingLlmBatchJobs()
  if (jobs.length === 0) return { checked: 0, merged: 0 }

  const llmConfig = await readLlmConfig()
  if (!llmConfig) {
    console.warn('[llm-batch-poll] pending jobs exist but no LLM provider is configured — skipping')
    return { checked: 0, merged: 0 }
  }

  const cache = await readExtractionCache()
  const at = new Date().toISOString()
  const now = Date.parse(at)
  let merged = 0
  let checked = 0

  for (const job of jobs) {
    if (shouldSkipGeminiFreePoll(job, now)) continue
    checked++
    try {
      const poll = await pollLlmBatch(job.jobName, llmConfig)
      await markLlmBatchJobChecked(job.jobName, at)
      if (poll.state === 'pending') continue

      if (poll.state === 'failed' || poll.state === 'expired') {
        // Affected items keep their (now-orphaned) llmBatchJob marker — no
        // extra code needed, isLlmBatchPending's 48h age check makes them
        // eligible again on its own once this job marker expires.
        await markLlmBatchJobResolved(job.jobName, poll.state, at)
        console.warn(`[llm-batch-poll] job ${job.jobName} ${poll.state}`)
        continue
      }

      const results = await fetchLlmBatchResults(job.jobName, poll.resultFileName, llmConfig, job.customIdMap)
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
      await markLlmBatchJobResolved(job.jobName, 'succeeded', at)
      console.log(`[llm-batch-poll] job ${job.jobName} succeeded — merged ${results.length} items`)
    } catch (err) {
      await markLlmBatchJobChecked(job.jobName, at)
      console.warn(`[llm-batch-poll] failed for job ${job.jobName}: ${(err as Error).message}`)
    }
  }

  return { checked, merged }
}
