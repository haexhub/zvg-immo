// G1 Roh-Archiv Rücklesepfad: liest Blob-Bytes aus dem Archiv zurück — der
// umgekehrte Weg zu raw-archive.ts's archiveBlob/storage-uploader.ts's
// drainOutbox. Für WP-6 (server/tasks/reprocess.ts), das Rules/LLM-Extraktion
// gegen bereits archivierte Captures laufen lässt statt gegen die Live-Portale.
// Best-effort wie raw-archive.ts: nie werfend, no-op ohne DB/Storage-Config.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ArchivedDocumentSetItem, CaptureKind } from './raw-archive'
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
 * Most recent `artifact_captures` row for `(kind, platform, externalId)`,
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
          `SELECT content_hash, source_url, captured_at FROM artifact_captures
           WHERE kind = $1 AND platform = $2 AND external_id = $3 AND source_url = $4
           ORDER BY captured_at DESC LIMIT 1`,
          [kind, platform, externalId, sourceUrl],
        )
      : await db.query<{ content_hash: string; source_url: string | null; captured_at: string }>(
          `SELECT content_hash, source_url, captured_at FROM artifact_captures
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

export async function readDocumentSetItems(
  platform: string,
  externalId: string,
  opts: { setHash?: string | null; version?: number | null } = {},
): Promise<ArchivedDocumentSetItem[] | null> {
  const db = getPool()
  if (!db) return null
  try {
    const conditions = ['platform = $1', 'external_id = $2']
    const params: unknown[] = [platform, externalId]
    if (opts.setHash) conditions.push(`set_hash = $${params.push(opts.setHash)}`)
    if (opts.version != null) conditions.push(`version = $${params.push(opts.version)}`)
    const { rows } = await db.query<{
      ordinal: number
      kind: string
      label: string | null
      filename: string | null
      file_id: string | null
      source_url: string
      content_hash: string
      content_type: string
    }>(
      `WITH selected_set AS (
         SELECT id
         FROM artifact_versions
         WHERE ${conditions.join(' AND ')}
         ORDER BY version DESC
         LIMIT 1
       )
       SELECT ordinal, kind, label, filename, file_id, source_url, content_hash, content_type
       FROM artifact_version_items
       WHERE set_id = (SELECT id FROM selected_set)
       ORDER BY ordinal ASC`,
      params,
    )
    return rows.map((row) => ({
      ordinal: row.ordinal,
      kind: row.kind as ArchivedDocumentSetItem['kind'],
      label: row.label,
      filename: row.filename,
      fileId: row.file_id,
      sourceUrl: row.source_url,
      contentHash: row.content_hash,
      contentType: row.content_type as ArchivedDocumentSetItem['contentType'],
    }))
  } catch (err) {
    console.warn(`[storage-download] readDocumentSetItems failed: ${(err as Error).message}`)
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
      'SELECT s3_key, content_type FROM artifact_blobs WHERE content_hash = $1',
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
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(row.s3_key, {}, { signal: AbortSignal.timeout(30_000) })
      if (error || !data) return null
      stored = Buffer.from(await data.arrayBuffer())
    }
    return row.content_type.endsWith('+gzip') ? gunzipSync(stored) : stored
  } catch (err) {
    console.warn(`[storage-download] downloadBlob failed: ${(err as Error).message}`)
    return null
  }
}
