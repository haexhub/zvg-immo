// Polls in-flight LLM Batch API jobs submitted by reprocess.ts and appends
// completed results to auction_details. Scheduled
// every 30 minutes (nuxt.config.ts) plus a boot-time nudge (llm-batch-poll-
// bootstrap.ts) so a job that finished while the server was down/restarting
// gets merged promptly instead of waiting for the next tick.

import { fetchLlmBatchResults, LLM_BATCH_JOB_EXPIRY_MS, pollLlmBatch } from '../utils/extract/llm-batch'
import { readExtractionLlmConfig, resolveLlmConfigForProfile } from '../utils/extract/llm-task-config'
import type { LlmConfig } from '../utils/extract/llm'
import { falsifiedRuleFields, mergeLlmResult, ruleChecksMatchingHint } from '../utils/extract/merge-llm-result'
import { buildReprocessFields } from '../utils/extract/reprocess-fields'
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
import { recordLlmUsage } from '../utils/llm-usage'
import { getPool } from '../utils/db'
import { recordTaskRunError } from '../utils/task-run-errors'

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

// A batch can take up to 48h to complete, long enough for the assigned
// profile/model to have changed in between — poll/fetch with the job's own
// submit-time profile where one was recorded, falling back to the current
// chain's config only for legacy jobs submitted before that snapshot
// existed (or a since-deleted profile).
async function resolveJobLlmConfig(job: LlmBatchJob, fallback: LlmConfig): Promise<LlmConfig> {
  if (!job.profileId) return fallback
  const pool = getPool()
  if (!pool) return fallback
  const resolved = await resolveLlmConfigForProfile(pool, job.profileId)
  return resolved ? { ...resolved, model: job.model ?? resolved.model } : fallback
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
      const jobConfig = await resolveJobLlmConfig(job, llmConfig)
      let poll: Awaited<ReturnType<typeof pollLlmBatch>>
      try {
        poll = await pollLlmBatch(job.jobName, jobConfig)
      } catch (pollErr) {
        await markLlmBatchJobChecked(job.jobName, at)
        // A job whose poll request itself keeps throwing (deleted profile,
        // revoked key, malformed job id — never a provider-reported state)
        // would otherwise stay 'pending' forever: never retried into a
        // resolution, and permanently inflating both this task's per-run work
        // and /settings' llm-batch-jobs overview. Give up at the same 48h
        // line isLlmBatchPending already uses to forgive an orphaned
        // per-item marker, so the two sides stay consistent. Scoped to just
        // the poll call — a later fetch/persist failure (job resolved fine,
        // our own write failed) must keep retrying, not expire a job whose
        // results are actually sitting there waiting.
        const submittedAtMs = Date.parse(job.submittedAt)
        if (Number.isFinite(submittedAtMs) && now - submittedAtMs >= LLM_BATCH_JOB_EXPIRY_MS) {
          await markLlmBatchJobResolved(job.jobName, 'expired', at, (pollErr as Error).message)
        }
        console.warn(`[llm-batch-poll] failed for job ${job.jobName}: ${(pollErr as Error).message}`)
        continue
      }
      throwIfTaskAborted(signal)
      await markLlmBatchJobChecked(job.jobName, at)
      if (poll.state === 'pending') continue

      if (poll.state === 'failed' || poll.state === 'expired') {
        // Affected items keep their (now-orphaned) llmBatchJob marker — no
        // extra code needed, isLlmBatchPending's 48h age check makes them
        // eligible again on its own once this job marker expires.
        await markLlmBatchJobResolved(job.jobName, poll.state, at, poll.errorMessage ?? null)
        // A failed/expired batch does not yield per-item result lines, but
        // every submitted item still needs a visible outcome on its auction.
        // The partial unique index in llm_usage_events makes this safe when a
        // provider later exposes the same item while recovering a job.
        if (job.provider && job.model) {
          const { provider, model } = job
          await Promise.all(Object.values(job.customIdMap).map(async (key) => {
            const identity = splitKey(key)
            if (!identity) return
            await recordLlmUsage({
              task: 'extraction',
              executionMode: 'batch',
              source: job.source,
              provider,
              model,
              profileId: job.profileId,
              platform: identity.platform,
              externalId: identity.externalId,
              usage: null,
              status: 'failed',
              errorMessage: poll.errorMessage ?? `Batch-Job ${poll.state}`,
              batchJobName: job.jobName,
            })
          }))
        }
        console.warn(`[llm-batch-poll] job ${job.jobName} ${poll.state}${poll.errorMessage ? `: ${poll.errorMessage}` : ''}`)
        continue
      }

      const results = await fetchLlmBatchResults(job.jobName, poll.resultFileName, jobConfig, job.customIdMap)
      throwIfTaskAborted(signal)
      let rulesFalsified = 0
      for (const { key, extraction, usage, error } of results) {
        throwIfTaskAborted(signal)
        const identity = splitKey(key)
        if (!identity) continue
        // Account for the provider outcome before touching auction storage:
        // a later persistence failure must not hide a call that already cost
        // tokens (and the batch identity keeps poll retries idempotent).
        if (job.provider && job.model) {
          await recordLlmUsage({
            task: 'extraction',
            executionMode: 'batch',
            source: job.source,
            provider: job.provider,
            model: job.model,
            profileId: job.profileId,
            platform: identity.platform,
            externalId: identity.externalId,
            usage,
            status: extraction === null ? 'failed' : 'succeeded',
            errorMessage: extraction === null ? error ?? 'Keine gültige Extraktion in der Batch-Antwort' : null,
            batchJobName: job.jobName,
          })
        }
        if (extraction === null) {
          void recordTaskRunError('reprocess', {
            category: 'llm',
            message: error ?? 'Keine gültige Extraktion in der Batch-Antwort',
            platform: identity.platform,
            externalId: identity.externalId,
          })
        }
        const record = records.get(key)
        if (!record) continue
        const storedPriorEntry = record.auction.extraction ?? undefined
        const priorState = fetchStates.get(key)
        if (!storedPriorEntry) continue
        // The item's LLM state belongs to whichever job claimed it last. An
        // older job whose provider only now recovered (its per-item marker
        // was already forgiven after LLM_BATCH_JOB_EXPIRY_MS and the item
        // re-submitted elsewhere) would otherwise merge against the newer
        // job's snapshot and clear its still-pending marker.
        if (priorState?.llmBatchJob !== job.jobName) {
          console.warn(`[llm-batch-poll] ${identity.platform}:${identity.externalId} no longer belongs to ${job.jobName} — skipping its result`)
          continue
        }
        const artifactVersionId = priorState?.llmArtifactVersionId ?? record.artifactVersionId
        const fields = buildReprocessFields(
          record.auction,
          storedPriorEntry,
          artifactVersionId !== record.artifactVersionId,
        )
        // The verdicts were formed against the rules values as they stood at
        // submit time; `fields` above is re-derived now, up to 48h later.
        // Only honour a verdict whose value survived that gap unchanged.
        const verified = extraction &&
          { ...extraction, ruleCheck: ruleChecksMatchingHint(extraction.ruleCheck, priorState.llmRulesHint, fields) }
        const falsified = falsifiedRuleFields(fields, verified)
        if (falsified.length) {
          rulesFalsified += falsified.length
          console.warn(`[llm-batch-poll] llm overruled rules value(s) for ${identity.platform}:${identity.externalId}: ${falsified.join(',')}`)
        }
        const mergedEntry = mergeLlmResult(
          storedPriorEntry,
          fields,
          verified,
          at,
          storedPriorEntry.photos,
        )
        const updated = { ...record.auction, extraction: mergedEntry }
        applyAuctionExtraction(updated, mergedEntry)
        // provider/model/profileId come from the job's own submit-time
        // snapshot, not the poll-time llmConfig above — a batch can take up
        // to 48h to complete, long enough for the assigned model to have
        // changed in between (see llm-batch-jobs.ts).
        await writeAuctionDetails(updated, mergedEntry, {
          artifactVersionId,
          llmProvider: job.provider,
          llmModel: job.model,
          llmProfileId: job.profileId,
          runTrigger: 'cron',
        })
        await upsertCurrentAuctions([updated], at)
        await writeAuctionLlmPipelineState(identity.platform, identity.externalId, {
          llmBatchJob: null,
          llmArtifactVersionId: null,
          llmRulesHint: null,
          llmFailures: extraction === null ? (priorState?.llmFailures ?? 0) + 1 : 0,
        })
        record.auction = updated
        record.artifactVersionId = artifactVersionId
        merged++
      }

      await markLlmBatchJobResolved(job.jobName, 'succeeded', at)
      console.log(`[llm-batch-poll] job ${job.jobName} succeeded — merged ${results.length} items, rulesFalsified=${rulesFalsified}`)
    } catch (err) {
      await markLlmBatchJobChecked(job.jobName, at)
      console.warn(`[llm-batch-poll] failed for job ${job.jobName}: ${(err as Error).message}`)
    }
  }

  return { checked, merged }
}
