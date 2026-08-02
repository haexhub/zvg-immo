// Polls in-flight LLM Batch API jobs submitted by reprocess.ts and appends
// completed results to auction_details. Scheduled
// every 30 minutes (nuxt.config.ts) plus a boot-time nudge (llm-batch-poll-
// bootstrap.ts) so a job that finished while the server was down/restarting
// gets merged promptly instead of waiting for the next tick.

import type { AuctionExtraction } from '~/types/auction'
import { fetchLlmBatchResults, pollLlmBatch } from '../utils/extract/llm-batch'
import { readExtractionLlmConfig } from '../utils/extract/llm-task-config'
import { mergeLlmResult, type MergeInputFields } from '../utils/extract/merge-llm-result'
import { applyAuctionExtraction } from '../utils/auction-extraction'
import { readAuctionRecordMap } from '../utils/auction-record'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { writeAuctionDetails } from '../utils/auction-details'
import { readAuctionFetchStates, writeAuctionLlmPipelineState } from '../utils/auction-fetch-state'
import {
  listPendingLlmBatchJobs,
  markLlmBatchJobChecked,
  markLlmBatchJobResolved,
  type LlmBatchJob,
} from '../utils/llm-batch-jobs'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'

const DEFAULT_GEMINI_FREE_BATCH_POLL_INTERVAL_HOURS = 6

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
// already-persisted rules-only entry written at explicit batch-submit time.
// `confident` (whether the LLM may still touch propertyType/
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
    description: 'Poll in-flight LLM Batch API jobs and write completed results to structured auction details.',
  },
  async run() {
    return await runExclusiveTask('llm-batch-poll', async (signal) => ({
      result: await runLlmBatchPoll(signal),
    }))
  },
})

export async function runLlmBatchPoll(signal?: AbortSignal): Promise<{ checked: number; merged: number }> {
  const jobs = await listPendingLlmBatchJobs()
  throwIfTaskAborted(signal)
  if (jobs.length === 0) return { checked: 0, merged: 0 }

  const llmConfig = await readExtractionLlmConfig()
  if (!llmConfig) {
    console.warn('[llm-batch-poll] pending jobs exist but no LLM provider is configured — skipping')
    return { checked: 0, merged: 0 }
  }

  const records = await readAuctionRecordMap()
  const fetchStates = await readAuctionFetchStates()
  throwIfTaskAborted(signal)
  const at = new Date().toISOString()
  const now = Date.parse(at)
  let merged = 0
  let checked = 0

  for (const job of jobs) {
    throwIfTaskAborted(signal)
    if (shouldSkipGeminiFreePoll(job, now)) continue
    checked++
    try {
      const poll = await pollLlmBatch(job.jobName, llmConfig)
      throwIfTaskAborted(signal)
      await markLlmBatchJobChecked(job.jobName, at)
      if (poll.state === 'pending') continue

      if (poll.state === 'failed' || poll.state === 'expired') {
        // Affected items keep their (now-orphaned) llmBatchJob marker — no
        // extra code needed, isLlmBatchPending's 48h age check makes them
        // eligible again on its own once this job marker expires.
        await markLlmBatchJobResolved(job.jobName, poll.state, at, poll.errorMessage ?? null)
        console.warn(`[llm-batch-poll] job ${job.jobName} ${poll.state}${poll.errorMessage ? `: ${poll.errorMessage}` : ''}`)
        continue
      }

      const results = await fetchLlmBatchResults(job.jobName, poll.resultFileName, llmConfig, job.customIdMap)
      throwIfTaskAborted(signal)
      for (const { key, extraction } of results) {
        throwIfTaskAborted(signal)
        const identity = splitKey(key)
        if (!identity) continue
        const record = records.get(key)
        const storedPriorEntry = record?.auction.extraction ?? undefined
        const priorState = fetchStates.get(key)
        const priorEntry = storedPriorEntry
        if (!priorEntry) continue
        const mergedEntry = mergeLlmResult(priorEntry, toMergeFields(priorEntry), extraction, at, priorEntry.photos)
        if (!record) continue
        const updated = { ...record.auction, extraction: mergedEntry }
        applyAuctionExtraction(updated, mergedEntry)
        await upsertCurrentAuctions([updated], at)
        await writeAuctionDetails(updated, mergedEntry, {
          artifactVersionId: priorState?.llmArtifactVersionId ?? record.artifactVersionId,
        })
        await writeAuctionLlmPipelineState(identity.platform, identity.externalId, {
          llmBatchJob: null,
          llmArtifactVersionId: null,
          llmFailures: extraction === null ? (priorState?.llmFailures ?? 0) + 1 : 0,
        })
        record.auction = updated
        record.artifactVersionId = priorState?.llmArtifactVersionId ?? record.artifactVersionId
        merged++
      }

      await markLlmBatchJobResolved(job.jobName, 'succeeded', at)
      console.log(`[llm-batch-poll] job ${job.jobName} succeeded — merged ${results.length} items`)
    } catch (err) {
      await markLlmBatchJobChecked(job.jobName, at)
      console.warn(`[llm-batch-poll] failed for job ${job.jobName}: ${(err as Error).message}`)
    }
  }

  return { checked, merged }
}
