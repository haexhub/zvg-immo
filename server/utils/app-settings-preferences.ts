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
