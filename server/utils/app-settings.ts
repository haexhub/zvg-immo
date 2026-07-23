// Generic key/value settings store (app_settings table) — admin-configurable
// values that take effect without a redeploy. First (and currently only)
// user: the per-use-case LLM max-output-tokens limits (see
// docs/plans/2026-07-23-llm-max-output-tokens-config.md). Table is reusable
// for future settings; readers should still fall back gracefully when a key
// is absent, since a fresh install has no rows yet.

import type { Pool } from 'pg'

export type LlmMaxTokensKind = 'extraction' | 'summary' | 'translation'

const KINDS: LlmMaxTokensKind[] = ['extraction', 'summary', 'translation']

// Exactly today's hard-coded values (the provider fallbacks in
// claude-proxy.ts/openai-compatible.ts/gemini-native.ts, and the
// resolveLlmConfig() overrides in summary.post.ts/translation.post.ts) — a
// fresh install with no app_settings row is not a behavior change.
export const DEFAULT_LLM_MAX_TOKENS: Record<LlmMaxTokensKind, number> = {
  extraction: 4096,
  summary: 1024,
  translation: 8192,
}

// Guards against a fat-fingered dashboard value silencing every LLM call
// (too low) or blowing up cost (too high) — not a meaningful real-world
// bound otherwise.
const MIN_MAX_TOKENS = 256
const MAX_MAX_TOKENS = 32_768

function keyFor(kind: LlmMaxTokensKind): string {
  return `llm_max_tokens_${kind}`
}

function clamp(value: number): number {
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)))
}

function coerce(value: unknown, kind: LlmMaxTokensKind): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LLM_MAX_TOKENS[kind]
}

export async function getLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind): Promise<number> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [keyFor(kind)],
  )
  return coerce(rows[0]?.value, kind)
}

export async function getAllLlmMaxTokens(db: Pool): Promise<Record<LlmMaxTokensKind, number>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1)',
    [KINDS.map(keyFor)],
  )
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const result = {} as Record<LlmMaxTokensKind, number>
  for (const kind of KINDS) result[kind] = coerce(byKey.get(keyFor(kind)), kind)
  return result
}

export async function setLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind, value: number): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [keyFor(kind), JSON.stringify(clamp(value))],
  )
}
