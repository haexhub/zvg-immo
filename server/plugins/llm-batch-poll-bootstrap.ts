// Fires llm-batch-poll once shortly after server startup so an explicit LLM
// Batch job that finished while the server was down/restarting gets merged
// promptly instead of waiting for the next 30-minute cron tick. Unlike
// enrich-bootstrap/refresh-bootstrap, no boot-crawl-gate check — this task
// never crawls an upstream portal (just Postgres + the provider Batch API), so
// there's no IP-ban risk to guard against and it's a cheap no-op when there
// are no pending jobs.

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void runTask('llm-batch-poll').catch((err: unknown) => {
      console.error('[llm-batch-poll-bootstrap] failed:', (err as Error).message)
    })
  }, 60_000)
})
