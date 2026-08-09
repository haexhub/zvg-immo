// Shared LLM fallback-chain resolution for every on-demand translation
// endpoint (auction title/description/address, place names) — factored out
// of translation.post.ts so server/api/place-names/translate.post.ts can
// reuse the exact same 'translation'-then-'extraction' profile chain and
// config fingerprinting instead of duplicating it.

import type { Pool } from 'pg'
import { getLlmKillSwitch, getLlmMaxTokens, getLlmProviderOverrideChain, type LlmProviderOverride } from '~/server/utils/app-settings'
import { resolveLlmConfig, type LlmConfig } from '~/server/utils/extract/llm'
import { sha256Hex } from '~/server/utils/raw-archive'

/** The full assigned fallback chain for the 'translation' use case — every
 *  profile assigned to 'translation', or (only when none is) every profile
 *  assigned to 'extraction', in order. Tried in sequence so a model that's
 *  rate-limited/over quota or otherwise unavailable (see gemini-native.ts)
 *  doesn't fail the whole request when another configured model could serve
 *  it. Empty when the admin kill switch (/settings) is on — same "nothing
 *  configured" contract callers already handle. */
export async function resolveActiveLlmConfigChain(db: Pool): Promise<LlmConfig[]> {
  if (await getLlmKillSwitch(db).catch(() => false)) return []
  const llmCfg = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const maxTokens = await getLlmMaxTokens(db, 'translation')
  const resolveChain = (chain: (LlmProviderOverride | typeof llmCfg)[]) =>
    chain
      .map((source) => resolveLlmConfig(source, { maxTokens }))
      .filter((config): config is LlmConfig => config != null)

  const resolvedTranslation = resolveChain(await getLlmProviderOverrideChain(db, 'translation'))
  if (resolvedTranslation.length > 0) return resolvedTranslation

  const resolvedExtraction = resolveChain(await getLlmProviderOverrideChain(db, 'extraction'))
  if (resolvedExtraction.length > 0) return resolvedExtraction

  return resolveChain(llmCfg ? [llmCfg] : [])
}

/** Identifies the resolved LLM fallback chain for a retry-lockout check — a
 *  /settings edit to any link (primary or a fallback: added, removed,
 *  reordered or fixed) produces a different fingerprint, which lets a
 *  previously failed attempt retry immediately instead of waiting out a
 *  content-translation.ts-style RETRY_AFTER window. Hashed (rather than
 *  storing provider/baseUrl/model/apiKey directly) so plaintext apiKeys from
 *  app_settings never get copied into a second column. */
export function fingerprintConfigChain(configs: readonly LlmConfig[]): string {
  return sha256Hex(Buffer.from(JSON.stringify(configs.map((config) => ({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey ?? '',
  })))))
}
