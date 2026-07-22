// G1 Roh-Archiv Rücklesepfad: liest Blob-Bytes aus dem Archiv zurück — der
// umgekehrte Weg zu raw-archive.ts's archiveBlob/storage-uploader.ts's
// drainOutbox. Für WP-6 (server/tasks/reprocess.ts), das Rules/LLM-Extraktion
// gegen bereits archivierte Captures laufen lässt statt gegen die Live-Portale.
// Best-effort wie raw-archive.ts: nie werfend, no-op ohne DB/Storage-Config.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { CaptureKind } from './raw-archive'
import { getPool } from './db'
import { getServiceClient } from './supabase'

function outboxDir(): string {
  return (useRuntimeConfig().rawOutboxDir as string | undefined) || join(process.cwd(), '.raw_outbox')
}

function bucketName(): string | null {
  return (useRuntimeConfig().storageBucket as string | undefined) || null
}

export interface CaptureRef {
  contentHash: string
  sourceUrl: string | null
  capturedAt: string
}

/**
 * Most recent `raw_captures` row for `(kind, platform, externalId)`,
 * optionally narrowed to a specific `sourceUrl` — used to pick the capture of
 * one particular attachment among several 'document' captures for the same
 * auction. Null when none exists or the archive isn't configured.
 */
export async function findLatestCapture(
  kind: CaptureKind,
  platform: string,
  externalId: string,
  sourceUrl?: string,
): Promise<CaptureRef | null> {
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = sourceUrl
      ? await db.query<{ content_hash: string; source_url: string | null; captured_at: string }>(
          `SELECT content_hash, source_url, captured_at FROM raw_captures
           WHERE kind = $1 AND platform = $2 AND external_id = $3 AND source_url = $4
           ORDER BY captured_at DESC LIMIT 1`,
          [kind, platform, externalId, sourceUrl],
        )
      : await db.query<{ content_hash: string; source_url: string | null; captured_at: string }>(
          `SELECT content_hash, source_url, captured_at FROM raw_captures
           WHERE kind = $1 AND platform = $2 AND external_id = $3
           ORDER BY captured_at DESC LIMIT 1`,
          [kind, platform, externalId],
        )
    const row = rows[0]
    if (!row) return null
    return { contentHash: row.content_hash, sourceUrl: row.source_url, capturedAt: row.captured_at }
  } catch (err) {
    console.warn(`[storage-download] findLatestCapture failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Reads a blob's bytes back from the archive — the local outbox first (not
 * yet drained by storage-uploader.ts), else Supabase Storage. Returns the
 * original (decompressed) bytes regardless of storage-side gzip. Null on any
 * failure (unknown hash, missing file, storage error, unconfigured).
 */
export async function downloadBlob(contentHash: string): Promise<Buffer | null> {
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = await db.query<{ s3_key: string; content_type: string }>(
      'SELECT s3_key, content_type FROM raw_blobs WHERE content_hash = $1',
      [contentHash],
    )
    const row = rows[0]
    if (!row) return null

    let stored: Buffer
    try {
      stored = await readFile(join(outboxDir(), row.s3_key))
    } catch {
      const bucket = bucketName()
      const supabase = getServiceClient()
      if (!bucket || !supabase) return null
      const { data, error } = await supabase.storage.from(bucket).download(row.s3_key)
      if (error || !data) return null
      stored = Buffer.from(await data.arrayBuffer())
    }
    return row.content_type.endsWith('+gzip') ? gunzipSync(stored) : stored
  } catch (err) {
    console.warn(`[storage-download] downloadBlob failed: ${(err as Error).message}`)
    return null
  }
}
