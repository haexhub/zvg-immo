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
 *  Any failure lands in task_run_errors under this identity (WP-7) instead of
 *  disappearing with the promise; that's what the admin page polls for
 *  "trial failed" instead of a dedicated status table. */
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
    const result = await reprocessAuction(platform, externalId, priorEntry, config, at, {})
    if (!result) throw new Error('Kein archiviertes Capture für diese Auktion gefunden.')

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
      trial: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[auction-admin-trial] failed for ${platform}:${externalId}: ${message}`)
    await recordTaskRunError('reprocess', { platform, externalId, category: 'admin_trial', message })
  }
}
