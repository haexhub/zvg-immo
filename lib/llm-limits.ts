export const MAX_LLM_FAILURES = 3

/** Once an auction hits MAX_LLM_FAILURES, the scheduled reprocess run won't
 *  retry it again until this many hours have passed since the last LLM
 *  attempt — a self-healing daily retry instead of a permanent lockout that
 *  only a manual force-reprocess could clear. */
export const LLM_FAILURE_RETRY_COOLDOWN_HOURS = 24

/** Upper bound for the backoff below: a locked auction is still retried at
 *  least every two weeks. */
export const MAX_LLM_FAILURE_RETRY_COOLDOWN_HOURS = 14 * 24

/** Cooldown before the scheduled run retries a locked-out auction again. It
 *  doubles with every failure past MAX_LLM_FAILURES (24h, 48h, 96h, ...):
 *  a flat 24h kept auctions that fail for good being retried every day
 *  forever. Manual retries ignore it (ReprocessOptions.ignoreCooldown). */
export function llmFailureRetryCooldownHours(llmFailures: number): number {
  const doublings = Math.max(0, llmFailures - MAX_LLM_FAILURES)
  return Math.min(MAX_LLM_FAILURE_RETRY_COOLDOWN_HOURS, LLM_FAILURE_RETRY_COOLDOWN_HOURS * 2 ** doublings)
}
