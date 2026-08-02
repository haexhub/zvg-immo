import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { createError } from 'h3'
import { getPool } from './db'
import { getServiceClient } from './supabase'

interface BlobRef {
  content_hash: string
  s3_key: string
}

export interface DeleteRawArchiveCountryResult {
  country: string
  deleted: {
    captures: number
    documentSets: number
    documentSetItems: number
    blobs: number
    localFiles: number
    storageFiles: number
  }
  failed: {
    localFiles: number
    storageFiles: number
  }
}

function outboxDir(): string {
  return (useRuntimeConfig().rawOutboxDir as string | undefined) || join(process.cwd(), '.raw_outbox')
}

function bucketName(): string | null {
  return (useRuntimeConfig().storageBucket as string | undefined) || null
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The original DB error is the useful one; rollback failures only add noise.
  }
}

async function removeLocalFiles(keys: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  const base = outboxDir()
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    const results = await Promise.all(
      chunk.map(async (key) => {
        try {
          await rm(join(base, key), { force: true })
          return true
        } catch (err) {
          console.warn(`[raw-archive-delete] local delete failed for ${key}: ${(err as Error).message}`)
          return false
        }
      }),
    )
    deleted += results.filter(Boolean).length
    failed += results.filter((ok) => !ok).length
  }
  return { deleted, failed }
}

async function removeStorageFiles(keys: string[]): Promise<{ deleted: number; failed: number }> {
  const bucket = bucketName()
  const supabase = getServiceClient()
  if (!bucket || !supabase || keys.length === 0) return { deleted: 0, failed: 0 }

  let deleted = 0
  let failed = 0
  const storage = supabase.storage.from(bucket)
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    try {
      const { error } = await storage.remove(chunk)
      if (error) throw new Error(error.message)
      deleted += chunk.length
    } catch (err) {
      console.warn(`[raw-archive-delete] storage delete failed: ${(err as Error).message}`)
      failed += chunk.length
    }
  }
  return { deleted, failed }
}

export async function deleteRawArchiveCountry(countryInput: string): Promise<DeleteRawArchiveCountryResult> {
  const country = countryInput.trim().toLowerCase()
  if (!/^[a-z]{2}$/.test(country)) {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiges Land.' })
  }

  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }

  const client = await db.connect()
  let orphanedBlobs: BlobRef[] = []
  let captures = 0
  let documentSets = 0
  let documentSetItems = 0
  try {
    await client.query('BEGIN')

    const candidates = await client.query<BlobRef>(
      `SELECT DISTINCT rb.content_hash, rb.s3_key
       FROM artifact_blobs rb
       WHERE EXISTS (
         SELECT 1 FROM artifact_captures rc
         WHERE rc.country = $1 AND rc.content_hash = rb.content_hash
       )
       OR EXISTS (
         SELECT 1
         FROM artifact_versions rds
         JOIN artifact_version_items rdsi ON rdsi.set_id = rds.id
         WHERE rds.country = $1 AND rdsi.content_hash = rb.content_hash
       )`,
      [country],
    )

    const itemCount = await client.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM artifact_versions rds
       JOIN artifact_version_items rdsi ON rdsi.set_id = rds.id
       WHERE rds.country = $1`,
      [country],
    )
    documentSetItems = Number(itemCount.rows[0]?.count ?? 0)

    const deletedSets = await client.query('DELETE FROM artifact_versions WHERE country = $1', [country])
    documentSets = deletedSets.rowCount ?? 0

    const deletedCaptures = await client.query('DELETE FROM artifact_captures WHERE country = $1', [country])
    captures = deletedCaptures.rowCount ?? 0

    const hashes = candidates.rows.map((row) => row.content_hash)
    if (hashes.length > 0) {
      const deletedBlobs = await client.query<BlobRef>(
        `DELETE FROM artifact_blobs rb
         WHERE rb.content_hash = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM artifact_captures rc WHERE rc.content_hash = rb.content_hash)
           AND NOT EXISTS (SELECT 1 FROM artifact_version_items rdsi WHERE rdsi.content_hash = rb.content_hash)
         RETURNING content_hash, s3_key`,
        [hashes],
      )
      orphanedBlobs = deletedBlobs.rows
    }

    await client.query('COMMIT')
  } catch (err) {
    await rollbackQuietly(client)
    throw createError({
      statusCode: 500,
      statusMessage: `Archiv konnte nicht gelöscht werden: ${(err as Error).message}`,
    })
  } finally {
    client.release()
  }

  const keys = orphanedBlobs.map((row) => row.s3_key)
  const [local, storage] = await Promise.all([removeLocalFiles(keys), removeStorageFiles(keys)])

  return {
    country,
    deleted: {
      captures,
      documentSets,
      documentSetItems,
      blobs: orphanedBlobs.length,
      localFiles: local.deleted,
      storageFiles: storage.deleted,
    },
    failed: {
      localFiles: local.failed,
      storageFiles: storage.failed,
    },
  }
}
