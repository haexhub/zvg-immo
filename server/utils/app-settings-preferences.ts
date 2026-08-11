import type { Pool } from 'pg'
import { readSetting, writeSetting } from './app-settings-store'

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

export async function getLlmKillSwitch(db: Pool): Promise<boolean> {
  const row = await readSetting(db, LLM_KILL_SWITCH_KEY)
  return typeof row?.value === 'boolean' ? row.value : DEFAULT_LLM_KILL_SWITCH
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
