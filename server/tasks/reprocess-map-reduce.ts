// Map-reduce extraction for auctions with more PDFs than one combined call
// can reasonably handle (see pdf-documents.ts's MAP_REDUCE_DOCUMENT_THRESHOLD).
// Map: one extractByLlm call per document group (already bounded to
// MAX_MAP_REDUCE_DOCUMENTS by buildDocumentSummaryInputs, and further sliced
// by the caller to fit the run's remaining LLM-call budget — see
// reprocess-single.ts), using the smaller DOCUMENT_SUMMARY_SCHEMA. Reduce:
// one extractByLlm call with the default UNIVERSAL_AUCTION_SCHEMA, fed the
// map results as structured text instead of raw documents — so its return
// type is identical to a normal single-call extractByLlm result and
// mergeLlmResult needs no changes at all.

import {
  DOCUMENT_SUMMARY_SCHEMA,
  DOCUMENT_SUMMARY_SCHEMA_NAME,
  DOCUMENT_SUMMARY_SYSTEM_PROMPT,
  extractByLlm,
  isDailyQuotaError,
  isRateLimitError,
  type ClampedExtraction,
  type LlmConfig,
  type LlmInput,
  type LlmUsage,
} from '~/server/utils/extract/llm'
import type { PreparedAttachmentDocument } from '~/server/utils/extract/llm-documents'
import type { DocumentSummaryInput } from '~/server/utils/extract/pdf-documents'

export interface MapReduceCallbacks {
  onLlmAttempt?: () => void
  onLlmError?: (err: unknown) => void
  /** Fires once per real map/reduce provider request — mirrors
   *  reprocessAuction's own onLlmCall exactly, so N+1 map-reduce calls are as
   *  visible to the caller (budget counting, llm_usage_events cost
   *  recording) as one regular call. */
  onLlmCall?: (call: {
    config: LlmConfig
    durationMs: number
    usage: LlmUsage | null
    status: 'succeeded' | 'failed'
    errorMessage: string | null
  }) => void | Promise<void>
}

interface MapAttemptResult {
  label: string
  extraction: ClampedExtraction | null
}

/**
 * One extractByLlm call, wired to the same onLlmAttempt/onLlmError/onLlmCall
 * shape reprocessAuction's own fallback loop uses for a single request.
 * Tolerates a genuine extraction failure (malformed/failed response) by
 * returning null — the caller decides what that means (excluded map
 * document vs. failed candidate). A capacity outage (rate limit/daily
 * quota) is NOT tolerated: it propagates uncaught, exactly like a plain
 * extractByLlm call, so it still reaches reprocess-run.ts's per-candidate
 * catch and correctly skips counting it toward llmFailures.
 */
async function attemptExtraction(
  input: LlmInput,
  config: LlmConfig,
  extractOpts: { schema?: Record<string, unknown>; systemPrompt?: string; name?: string },
  callbacks: MapReduceCallbacks,
): Promise<ClampedExtraction | null> {
  let providerAttempted = false
  let providerError: string | null = null
  let attemptUsage: LlmUsage | null = null
  const attemptStartedAt = Date.now()
  try {
    const result = await extractByLlm(input, config, {
      ...extractOpts,
      onProviderAttempt: () => {
        providerAttempted = true
        callbacks.onLlmAttempt?.()
      },
      onProviderError: (err) => {
        providerError = err instanceof Error ? err.message : String(err)
        callbacks.onLlmError?.(err)
      },
      onUsage: (usage) => { attemptUsage = usage },
    })
    if (providerAttempted) {
      await callbacks.onLlmCall?.({
        config,
        durationMs: Date.now() - attemptStartedAt,
        usage: attemptUsage,
        status: result === null ? 'failed' : 'succeeded',
        errorMessage: result === null ? providerError ?? 'Keine gültige Extraktion in der Provider-Antwort' : null,
      })
    }
    return result
  } catch (err) {
    if (providerAttempted) {
      await callbacks.onLlmCall?.({
        config,
        durationMs: Date.now() - attemptStartedAt,
        usage: attemptUsage,
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
    if (isRateLimitError(err) || isDailyQuotaError(err)) throw err
    return null
  }
}

function buildReduceDocumentText(
  mapResults: readonly MapAttemptResult[],
  deferredDocumentLabels: readonly string[] = [],
): string {
  const preface =
    'Es folgen strukturierte Zwischen-Zusammenfassungen mehrerer Dokumente derselben Auktion, jeweils aus einem ' +
    'separaten Analyseschritt für ein einzelnes Dokument oder eine kleine budgetbegrenzte Dokumentgruppe. ' +
    'Widersprechen sich Dokumente, bevorzuge das gewichtigere ' +
    '(Gutachten vor Exposé/Ankündigung) und vermerke den Widerspruch kurz in documentSummary.'
  const blocks = mapResults.map((r) =>
    r.extraction
      ? `=== ${r.label} ===\n${JSON.stringify(r.extraction)}`
      : `=== ${r.label} (Analyse fehlgeschlagen) ===\nDieses Dokument konnte nicht ausgewertet werden.`,
  )
  const deferred = deferredDocumentLabels.length > 0
    ? `\n\n=== Dokumente nicht ausgewertet ===\n` +
      `Die folgenden Dokumente konnten wegen des Map-Call- oder Run-Budget-Limits nicht ausgewertet werden: ` +
      deferredDocumentLabels.join(', ') + '.'
    : ''
  return `${preface}\n\n${blocks.join('\n\n')}${deferred}`
}

/**
 * documentGroups is expected to already be sliced to fit the caller's
 * remaining LLM-call budget for this run (documentGroups.length + 1 calls
 * total) — this function makes no budget decisions of its own.
 *
 * Partial failure: a map call that fails (not a capacity outage) is
 * excluded from the reduce input with an honest "couldn't be read" note
 * rather than aborting the whole candidate — one bad document must not lock
 * out an otherwise-working auction. Only when every map call fails is the
 * candidate treated as failed (reduce is skipped entirely — nothing to
 * reconcile, and it would burn a call for free).
 */
export async function runMapReduceExtraction(
  documentGroups: ReadonlyArray<DocumentSummaryInput<PreparedAttachmentDocument>>,
  base: LlmInput,
  config: LlmConfig,
  callbacks: MapReduceCallbacks,
): Promise<ClampedExtraction | null> {
  const mapResults: MapAttemptResult[] = await Promise.all(
    documentGroups.map(async (group) => ({
      label: group.label,
      extraction: await attemptExtraction(
        { title: base.title, description: null, ...group.parts },
        config,
        { schema: DOCUMENT_SUMMARY_SCHEMA, systemPrompt: DOCUMENT_SUMMARY_SYSTEM_PROMPT, name: DOCUMENT_SUMMARY_SCHEMA_NAME },
        callbacks,
      ),
    })),
  )

  if (mapResults.every((r) => r.extraction == null)) return null

  const deferredDocumentLabels = [...new Set(
    documentGroups.flatMap((group) => group.deferredDocumentLabels ?? []),
  )]
  const reduceInput: LlmInput = {
    ...base,
    pdfText: buildReduceDocumentText(mapResults, deferredDocumentLabels),
  }
  return attemptExtraction(reduceInput, config, {}, callbacks)
}
