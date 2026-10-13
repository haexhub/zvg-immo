// One-off migration: prefixes every existing artifact_blobs.s3_key with a German
// country folder (see server/utils/raw-archive.ts shardedKey()), so the
// bucket becomes browsable by country in Supabase Studio. Country per hash
// is looked up from the earliest artifact_captures row referencing it (a blob can
// only have one folder; content-hash-dedup means the same bytes are assumed
// to belong to a single country in practice).
//
// Moves the object in Supabase Storage if already uploaded, otherwise
// renames the local outbox file, then updates artifact_blobs.s3_key to match.
//
// Usage:
//   NUXT_DATABASE_URL=... NUXT_STORAGE_BUCKET=... NUXT_SUPABASE_URL=... \
//   NUXT_SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/migrate-raw-archive-country-folders.ts [--apply]
//
// Without --apply, only reports what would change (dry run, no writes).

import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { Pool } from 'pg'
import { EXT, shardedKey, type BlobContentType } from '../server/utils/raw-archive'

const apply = process.argv.includes('--apply')

const databaseUrl = process.env.NUXT_DATABASE_URL
const bucket = process.env.NUXT_STORAGE_BUCKET
const supabaseUrl = process.env.NUXT_SUPABASE_URL
const serviceKey = process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
const outboxDir = process.env.NUXT_RAW_OUTBOX_DIR || join(process.cwd(), '.raw_outbox')

if (!databaseUrl || !bucket || !supabaseUrl || !serviceKey) {
  console.error(
    'Missing one of NUXT_DATABASE_URL / NUXT_STORAGE_BUCKET / NUXT_SUPABASE_URL / NUXT_SUPABASE_SERVICE_ROLE_KEY',
  )
  process.exit(1)
}

const pool = new Pool({ connectionString: databaseUrl })
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

// artifact_blobs.content_type is the POST-compression type ('application/json+gzip'
// etc, see storedContentType() in raw-archive.ts) — map back to the
// pre-compression BlobContentType shardedKey() expects, the same way the
// archive download route does. An unknown type yields null so the blob is
// skipped instead of being renamed under a guessed extension.
function toBlobContentType(stored: string): BlobContentType | null {
  const type = stored.replace(/\+gzip$/, '')
  return Object.hasOwn(EXT, type) ? (type as BlobContentType) : null
}

// Moves the stored object (bucket if uploaded, else the local outbox file).
async function relocate(blob: BlobRow, from: string, to: string): Promise<void> {
  if (blob.uploaded_at) {
    const { error } = await supabase.storage.from(bucket!).move(from, to)
    if (error) throw new Error(error.message)
    return
  }
  const newPath = join(outboxDir, to)
  await mkdir(dirname(newPath), { recursive: true })
  await rename(join(outboxDir, from), newPath)
}

interface BlobRow {
  content_hash: string
  s3_key: string
  content_type: string
  uploaded_at: string | null
}

async function main() {
  const { rows: blobs } = await pool.query<BlobRow>(
    'SELECT content_hash, s3_key, content_type, uploaded_at FROM artifact_blobs',
  )

  const { rows: earliestCaptures } = await pool.query<{ content_hash: string; country: string }>(
    `SELECT DISTINCT ON (content_hash) content_hash, country
     FROM artifact_captures
     ORDER BY content_hash, captured_at ASC`,
  )
  const countryByHash = new Map(earliestCaptures.map((r) => [r.content_hash, r.country]))

  let moved = 0
  let alreadyDone = 0
  let skippedNoCapture = 0
  let skippedUnknownType = 0
  let failed = 0

  for (const blob of blobs) {
    const country = countryByHash.get(blob.content_hash)
    if (!country) {
      skippedNoCapture++
      console.warn(`[migrate] no artifact_captures row for ${blob.content_hash}, skipping`)
      continue
    }

    const contentType = toBlobContentType(blob.content_type)
    if (!contentType) {
      skippedUnknownType++
      console.warn(`[migrate] unknown content_type ${blob.content_type} for ${blob.content_hash}, skipping`)
      continue
    }
    const newKey = shardedKey(blob.content_hash, contentType, country)
    if (newKey === blob.s3_key) {
      alreadyDone++
      continue
    }

    console.log(`${apply ? '[migrate]' : '[dry-run]'} ${blob.s3_key} -> ${newKey}`)
    if (!apply) {
      moved++
      continue
    }

    try {
      await relocate(blob, blob.s3_key, newKey)
      try {
        await pool.query('UPDATE artifact_blobs SET s3_key = $1 WHERE content_hash = $2', [newKey, blob.content_hash])
      } catch (err) {
        // s3_key still names the old location, so put the object back there;
        // otherwise every reader (storage-download.ts) and later run would
        // look for an object that no longer exists.
        await relocate(blob, newKey, blob.s3_key).catch((rollbackErr: unknown) => {
          console.error(
            `[migrate] could not move ${newKey} back to ${blob.s3_key}, fix s3_key by hand: ${(rollbackErr as Error).message}`,
          )
        })
        throw err
      }
      moved++
    } catch (err) {
      failed++
      console.error(`[migrate] failed for ${blob.content_hash} (${blob.s3_key} -> ${newKey}): ${(err as Error).message}`)
    }
  }

  console.log(
    `${apply ? 'moved' : 'would move'}=${moved} alreadyDone=${alreadyDone} skippedNoCapture=${skippedNoCapture} skippedUnknownType=${skippedUnknownType} failed=${failed}`,
  )
  await pool.end()
}

main().catch((err) => {
  console.error(`[migrate] aborted: ${(err as Error).message}`)
  process.exit(1)
})
