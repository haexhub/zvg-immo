// Admin-triggered single-model comparison run for one auction (docs/plans/
// 2026-08-08-admin-auktions-technikseite.md, WP-4). Reuses reprocessAuction
// (the same extraction path runReprocess's cron loop calls) against exactly
// one caller-chosen LLM profile — no chain, no fallback, so the result
// measures that model alone — and writes it as a trial version that never
// touches the live (is_latest) row.
//
// Deliberately does NOT call writeAuctionLlmPipelineState or
// upsertCurrentAuctions: an experiment must not push the auction toward
// MAX_LLM_FAILURES lockout, and the public search projection must stay on
// the live version regardless of how many trials ran.

import { getPool } from './db'
import { readAuctionRecord } from './auction-record'
import { applyAuctionExtraction } from './auction-extraction'
import { writeAuctionDetails } from './auction-details'
import { reprocessAuction } from '../tasks/reprocess'
import { resolveLlmConfigForProfile } from './extract/llm-task-config'
import { getLlmKillSwitch } from './app-settings'
import { recordTaskRunError } from './task-run-errors'
import { recordLlmUsage } from './llm-usage'
import { resolveCostUsd } from './extract/llm-pricing'
import type { Auction } from '~/types/auction'

export type AdminTrialReprocessOutcome =
  | { ok: true }
  | { ok: false; reason: 'unknown_profile' | 'not_found' | 'llm_disabled' }

/** Resolves the profile and confirms the identity exists — fast, synchronous
 *  checks the caller can 400 on before returning `{started: true}` and
 *  detaching the actual (slow) extraction run. */
export async function validateAdminTrialReprocess(
  platform: string,
  externalId: string,
  profileId: string,
): Promise<AdminTrialReprocessOutcome> {
  const db = getPool()
  if (!db) return { ok: false, reason: 'not_found' }
  if (await getLlmKillSwitch(db).catch(() => false)) return { ok: false, reason: 'llm_disabled' }
  const config = await resolveLlmConfigForProfile(db, profileId)
  if (!config) return { ok: false, reason: 'unknown_profile' }
  const record = await readAuctionRecord(platform, externalId)
  if (!record) return { ok: false, reason: 'not_found' }
  return { ok: true }
}

/** The actual run — called fire-and-forget by the endpoint after validation.
 *  A failed provider call lands in llm_usage_events via onLlmCall below, which
 *  is what the admin page's extraction-runs table polls for instead of a
 *  dedicated status table; recordTaskRunError below is a second, coarser log
 *  kept for the country-wide LLM status view (server/api/settings/llm-status). */
export async function runAdminTrialReprocess(platform: string, externalId: string, profileId: string): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    const config = await resolveLlmConfigForProfile(db, profileId)
    if (!config) throw new Error(`Unbekanntes LLM-Profil: ${profileId}`)
    const record = await readAuctionRecord(platform, externalId)
    if (!record) throw new Error(`Auktion nicht gefunden: ${platform}:${externalId}`)

    const at = new Date().toISOString()
    const priorEntry = record.auction.extraction ?? undefined
    // Held in an object because reprocessAuction reports the outcome through a
    // callback, and a failed provider call does not necessarily throw.
    const lastLlmCall: { status: 'succeeded' | 'failed' | null } = { status: null }
    const result = await reprocessAuction(platform, externalId, priorEntry, config, at, {
      // Mirrors reprocess-run.ts's onLlmCall: without this, a failed attempt
      // (the case a trial is most often run to check) never reaches
      // llm_usage_events, and the technical page has nothing but the generic
      // task_run_errors entry below to show for it.
      onLlmCall: async ({ config: usedConfig, durationMs, usage, status, errorMessage }) => {
        lastLlmCall.status = status
        await recordLlmUsage({
          task: 'extraction',
          executionMode: 'sync',
          source: 'admin-trial',
          provider: usedConfig.provider ?? 'openai-compatible',
          model: usedConfig.model,
          profileId: usedConfig.profileId ?? null,
          platform,
          externalId,
          usage,
          status,
          errorMessage,
          durationMs,
        })
      },
    })
    if (!result) throw new Error('Kein archiviertes Capture für diese Auktion gefunden.')

    // A provider answer without a usable extraction does not throw —
    // reprocessAuction still returns a (rules-only) entry. Persisting that as a
    // trial version would show the same failed attempt twice on the technical
    // page: once as the failed llm_usage_events row, once as a version claiming
    // this model produced it. The failed row is the honest record; stop here.
    if (lastLlmCall.status === 'failed') {
      console.warn(`[auction-admin-trial] provider call failed for ${platform}:${externalId}, no trial version written`)
      return
    }

    // Mirrors persistEntry's (server/tasks/reprocess.ts) base-auction
    // construction: an identity with no auction_details row yet has every
    // crawl-owned field blank on record.auction (LEFT JOIN LATERAL finds
    // nothing to join), so the archived capture this run just read is the
    // correct source instead — see the matching comment there.
    const base: Auction = record.detailsId == null
      ? { ...result.auction, lat: record.auction.lat, lng: record.auction.lng }
      : record.auction
    const updated: Auction = { ...base, extraction: result.entry }
    applyAuctionExtraction(updated, result.entry)

    await writeAuctionDetails(updated, result.entry, {
      artifactVersionId: result.artifactVersionId,
      llmProvider: result.llmConfigUsed ? (result.llmConfigUsed.provider ?? 'openai-compatible') : null,
      llmModel: result.llmConfigUsed?.model ?? null,
      llmProfileId: result.llmConfigUsed?.profileId ?? null,
      runTrigger: 'manual',
      llmDurationMs: result.llmDurationMs,
      llmCostUsd: result.llmConfigUsed ? resolveCostUsd(result.llmConfigUsed.model, result.llmUsage) : null,
      llmInputTokens: result.llmUsage?.inputTokens ?? null,
      llmOutputTokens: result.llmUsage?.outputTokens ?? null,
      trial: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[auction-admin-trial] failed for ${platform}:${externalId}: ${message}`)
    await recordTaskRunError('reprocess', { platform, externalId, category: 'admin_trial', message })
  }
}
