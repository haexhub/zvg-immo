export const MAX_LLM_FAILURES = 3

/** Once an auction hits MAX_LLM_FAILURES, the scheduled reprocess run won't
 *  retry it again until this many hours have passed since the last LLM
 *  attempt — a self-healing daily retry instead of a permanent lockout that
 *  only a manual force-reprocess could clear. */
export const LLM_FAILURE_RETRY_COOLDOWN_HOURS = 24
