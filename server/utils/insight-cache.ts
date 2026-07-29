// Postgres-backed cache for on-demand LLM insight cards (auction_insights
// table). One table serves every insight definition in
// server/utils/insights/registry.ts. Immutable per (insight_id, content_hash)
// — once written, an entry is never updated, so a concurrent duplicate insert
// (two requests racing on the same cache miss) is a harmless no-op.

import type { Pool } from 'pg'

export interface InsightRow {
  payload: unknown
  at: string
}

export async function readInsight(
  db: Pool,
  insightId: string,
  contentHash: string,
): Promise<InsightRow | null> {
  const { rows } = await db.query<InsightRow>(
    `SELECT payload, at FROM auction_insights WHERE insight_id = $1 AND content_hash = $2`,
    [insightId, contentHash],
  )
  return rows[0] ?? null
}

export async function writeInsight(
  db: Pool,
  insightId: string,
  contentHash: string,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO auction_insights (insight_id, content_hash, payload, at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (insight_id, content_hash) DO NOTHING`,
    [insightId, contentHash, JSON.stringify(payload)],
  )
}
