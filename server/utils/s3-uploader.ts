// Drains the local raw-archive outbox into the primary S3-compatible bucket:
// every `raw_blobs` row without `uploaded_at` gets PUT, then marked uploaded
// and deleted locally. Only after a *confirmed* upload — so a transient S3
// outage just leaves blobs in the outbox for the next run to retry, never
// losing bytes. Best-effort like raw-archive.ts: never throws, no-op without
// NUXT_DATABASE_URL or a complete S3 config.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getPool } from './db'

interface S3Config {
  endpoint: string
  bucket: string
  accessKey: string
  secretKey: string
  region: string
}

function readS3Config(): S3Config | null {
  const c = useRuntimeConfig().s3 as
    | { endpoint?: string; bucket?: string; accessKey?: string; secretKey?: string; region?: string }
    | undefined
  if (!c?.endpoint || !c?.bucket || !c?.accessKey || !c?.secretKey) return null
  return {
    endpoint: c.endpoint,
    bucket: c.bucket,
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    region: c.region || 'auto',
  }
}

function outboxDir(): string {
  return useRuntimeConfig().rawOutboxDir || join(process.cwd(), '.raw_outbox')
}

function makeClient(cfg: S3Config): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  })
}

interface PendingBlob {
  content_hash: string
  s3_key: string
  content_type: string
}

export interface DrainResult {
  uploaded: number
  failed: number
}

/** Uploads every not-yet-uploaded outbox blob to Primary S3. No-op (returns
 *  zeros) without DB or S3 config. Never throws. */
export async function drainOutbox(): Promise<DrainResult> {
  const db = getPool()
  if (!db) return { uploaded: 0, failed: 0 }
  const cfg = readS3Config()
  if (!cfg) return { uploaded: 0, failed: 0 }

  let uploaded = 0
  let failed = 0
  try {
    const { rows } = await db.query<PendingBlob>(
      'SELECT content_hash, s3_key, content_type FROM raw_blobs WHERE uploaded_at IS NULL',
    )
    if (rows.length === 0) return { uploaded: 0, failed: 0 }

    const client = makeClient(cfg)
    const dir = outboxDir()
    for (const row of rows) {
      try {
        const body = await readFile(join(dir, row.s3_key))
        await client.send(
          new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: row.s3_key,
            Body: body,
            ContentType: row.content_type,
          }),
        )
        await db.query('UPDATE raw_blobs SET uploaded_at = now() WHERE content_hash = $1', [
          row.content_hash,
        ])
        await rm(join(dir, row.s3_key), { force: true })
        uploaded++
      } catch (err) {
        console.warn(`[s3-uploader] upload failed for ${row.content_hash}: ${(err as Error).message}`)
        failed++
      }
    }
  } catch (err) {
    console.warn(`[s3-uploader] drain failed: ${(err as Error).message}`)
  }
  return { uploaded, failed }
}
