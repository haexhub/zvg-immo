import type { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readSetting, upsertSetting, writeSetting } from './app-settings-store'

const HIDE_RULES_ONLY_KEY = 'hide_rules_only_auctions'
export const DEFAULT_HIDE_RULES_ONLY_AUCTIONS = true

export async function getHideRulesOnlyAuctions(db: Pool): Promise<boolean> {
  const row = await readSetting(db, HIDE_RULES_ONLY_KEY)
  return typeof row?.value === 'boolean' ? row.value : DEFAULT_HIDE_RULES_ONLY_AUCTIONS
}

export async function setHideRulesOnlyAuctions(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, HIDE_RULES_ONLY_KEY, value)
}

const LLM_KILL_SWITCH_KEY = 'llm_kill_switch'
export const DEFAULT_LLM_KILL_SWITCH = false

/** The stored switch; throws on a read error. For the /settings status view,
 * which must surface that error instead of showing a switch nobody set. */
export async function readLlmKillSwitch(db: Pool): Promise<boolean> {
  const row = await readSetting(db, LLM_KILL_SWITCH_KEY)
  return typeof row?.value === 'boolean' ? row.value : DEFAULT_LLM_KILL_SWITCH
}

/** Fails closed: an unreadable switch counts as on, so a transient DB error
 * can never let paid LLM calls through while an admin has them blocked. */
export async function getLlmKillSwitch(db: Pool): Promise<boolean> {
  try {
    return await readLlmKillSwitch(db)
  } catch (err) {
    console.warn('[llm-kill-switch] read failed, treating the switch as on', err)
    return true
  }
}

export async function setLlmKillSwitch(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, LLM_KILL_SWITCH_KEY, value)
}

const AUTOMATIC_CRAWLING_ENABLED_KEY = 'automatic_crawling_enabled'
const AUTOMATIC_LLM_ENABLED_KEY = 'automatic_llm_enabled'
export const DEFAULT_AUTOMATIC_CRAWLING_ENABLED = true
export const DEFAULT_AUTOMATIC_LLM_ENABLED = true

async function getBooleanPreference(db: Pool, key: string, fallback: boolean): Promise<boolean> {
  const row = await readSetting(db, key)
  return typeof row?.value === 'boolean' ? row.value : fallback
}

/** Controls scheduled and boot-time portal crawls. Manual admin retries are
 * deliberately not covered — see the `trigger: 'manual'` task payloads. */
export async function getAutomaticCrawlingEnabled(db: Pool): Promise<boolean> {
  return getBooleanPreference(db, AUTOMATIC_CRAWLING_ENABLED_KEY, DEFAULT_AUTOMATIC_CRAWLING_ENABLED)
}

export async function setAutomaticCrawlingEnabled(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, AUTOMATIC_CRAWLING_ENABLED_KEY, value)
}

/** Controls only scheduled/boot-time reprocessing. The LLM kill switch stays
 * separate, as it blocks every LLM call including explicit admin actions. */
export async function getAutomaticLlmEnabled(db: Pool): Promise<boolean> {
  return getBooleanPreference(db, AUTOMATIC_LLM_ENABLED_KEY, DEFAULT_AUTOMATIC_LLM_ENABLED)
}

export async function setAutomaticLlmEnabled(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, AUTOMATIC_LLM_ENABLED_KEY, value)
}

const LLM_MAX_PER_RUN_KEY = 'llm_max_per_run'
const LLM_CONCURRENCY_KEY = 'llm_concurrency'
export const MAX_LLM_MAX_PER_RUN = 1000
export const MAX_LLM_CONCURRENCY = 8

async function getBoundedInt(db: Pool, key: string, max: number): Promise<number | null> {
  const value = (await readSetting(db, key))?.value
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : null
}

/** Admin-set cap on LLM calls per scheduled reprocess run, or null when none
 * is stored (the env/default value in reprocess-budget.ts applies then). Takes
 * effect on the next run — no redeploy. */
export async function getLlmMaxPerRun(db: Pool): Promise<number | null> {
  return getBoundedInt(db, LLM_MAX_PER_RUN_KEY, MAX_LLM_MAX_PER_RUN)
}

/** Admin-set number of candidates reprocess handles in parallel, or null. */
export async function getLlmConcurrency(db: Pool): Promise<number | null> {
  return getBoundedInt(db, LLM_CONCURRENCY_KEY, MAX_LLM_CONCURRENCY)
}

/** Writes the automation preferences in one transaction, so a failure on a
 * later upsert cannot leave one preference changed while the caller's error
 * handling assumes none of the writes took effect. `llmMaxPerRun` and
 * `llmConcurrency` are left untouched when undefined and cleared (back to the
 * env default) when null. */
export async function setAutomationSettings(
  db: Pool,
  value: { crawlersEnabled: boolean; llmEnabled: boolean; llmMaxPerRun?: number | null; llmConcurrency?: number | null },
): Promise<void> {
  await drizzle(db).transaction(async (tx) => {
    await upsertSetting(tx, AUTOMATIC_CRAWLING_ENABLED_KEY, value.crawlersEnabled)
    await upsertSetting(tx, AUTOMATIC_LLM_ENABLED_KEY, value.llmEnabled)
    if (value.llmMaxPerRun !== undefined) await upsertSetting(tx, LLM_MAX_PER_RUN_KEY, value.llmMaxPerRun)
    if (value.llmConcurrency !== undefined) await upsertSetting(tx, LLM_CONCURRENCY_KEY, value.llmConcurrency)
  })
}
