// Tail end of a batch-mode reprocess run: hand the collected items to the
// provider's Batch API and mark every accepted one on its auction. Split out
// of reprocess-run.ts purely because that orchestrator sits at the repo's
// 500-line module ceiling — this block is the one part of the run that needs
// nothing from the candidate loop but the maps it filled.

import type { LlmConfig, LlmInput, RulesHint } from '~/server/utils/extract/llm'
import { submitLlmBatch } from '~/server/utils/extract/llm-batch'
import { writeAuctionLlmPipelineState, type AuctionFetchState } from '~/server/utils/auction-fetch-state'

/** Per-item facts collected while the candidate loop queued the batch, keyed
 *  by `platform:externalId` — recorded on each submitted auction so
 *  llm-batch-poll can merge its result against the state it was built from
 *  (see writeAuctionLlmPipelineState). */
export interface BatchSubmitState {
  artifactVersions: Map<string, number | null>
  rulesHints: Map<string, RulesHint | null>
  fetchStates: Map<string, AuctionFetchState>
}

export async function submitReprocessBatch(
  items: { key: string; input: LlmInput }[],
  llmConfig: LlmConfig | null,
  state: BatchSubmitState,
): Promise<void> {
  if (items.length === 0 || !llmConfig) return
  const submission = await submitLlmBatch(items, llmConfig, 'reprocess')
  if (!submission) {
    console.warn(`[reprocess] LLM batch submission failed for ${items.length} items`)
    return
  }
  // Same rationale enrich.ts used to apply: mark every submitted item so a
  // second runReprocess({ batch: true }) call doesn't re-submit it to a new
  // job while this one is still in flight (job submission isn't idempotent).
  for (const item of submission.submitted) {
    const separator = item.key.indexOf(':')
    if (separator <= 0) continue
    await writeAuctionLlmPipelineState(item.key.slice(0, separator), item.key.slice(separator + 1), {
      llmBatchJob: item.jobName,
      llmArtifactVersionId: state.artifactVersions.get(item.key) ?? null,
      llmRulesHint: state.rulesHints.get(item.key) ?? null,
      llmFailures: state.fetchStates.get(item.key)?.llmFailures ?? 0,
      llmAttempted: true,
    })
  }
  console.log(`[reprocess] submitted LLM batch ${submission.jobName} with ${submission.submitted.length} items`)
  if (submission.retryItems.length > 0) {
    console.warn(`[reprocess] ${submission.retryItems.length} LLM batch item(s) were not submitted`)
  }
}
