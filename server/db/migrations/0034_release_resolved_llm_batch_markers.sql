-- Jobs that already reached a terminal state before llm-batch-poll started
-- releasing their item markers (clearLlmBatchJobMarkers) left them behind.
-- isLlmBatchPending ages a marker by auction_fetch_state.updated_at, which
-- every crawl, claim and photo write bumps, so an actively crawled auction
-- holding one never became eligible for extraction again.
UPDATE "auction_fetch_state"
SET "llm_batch_job" = NULL, "llm_artifact_version_id" = NULL, "llm_rules_hint" = NULL, "updated_at" = now()
WHERE "llm_batch_job" IN (SELECT "job_name" FROM "llm_batch_jobs" WHERE "status" <> 'pending');
