// One-off migration: prefixes every existing raw_blobs.s3_key with a German
// country folder (see server/utils/raw-archive.ts shardedKey()), so the
// bucket becomes browsable by country in Supabase Studio. Country per hash
// is looked up from the earliest raw_captures row referencing it (a blob can
// only have one folder; content-hash-dedup means the same bytes are assumed
// to belong to a single country in practice).
//
// Moves the object in Supabase Storage if already uploaded, otherwise
// renames the local outbox file, then updates raw_blobs.s3_key to match.
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
import { shardedKey, type BlobContentType } from '../server/utils/raw-archive.ts'

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

// raw_blobs.content_type is the POST-compression type ('application/json+gzip'
// etc, see storedContentType() in raw-archive.ts) — map back to the
// pre-compression BlobContentType shardedKey() expects.
function toBlobContentType(stored: string): BlobContentType {
  if (stored.startsWith('application/json')) return 'application/json'
  if (stored.startsWith('text/html')) return 'text/html'
  if (stored === 'application/pdf') return 'application/pdf'
  return 'application/vnd.docx'
}

interface BlobRow {
  content_hash: string
  s3_key: string
  content_type: string
  uploaded_at: string | null
}

async function main() {
  const { rows: blobs } = await pool.query<BlobRow>(
    'SELECT content_hash, s3_key, content_type, uploaded_at FROM raw_blobs',
  )

  const { rows: earliestCaptures } = await pool.query<{ content_hash: string; country: string }>(
    `SELECT DISTINCT ON (content_hash) content_hash, country
     FROM raw_captures
     ORDER BY content_hash, captured_at ASC`,
  )
  const countryByHash = new Map(earliestCaptures.map((r) => [r.content_hash, r.country]))

  let moved = 0
  let alreadyDone = 0
  let skippedNoCapture = 0
  let failed = 0

  for (const blob of blobs) {
    const country = countryByHash.get(blob.content_hash)
    if (!country) {
      skippedNoCapture++
      console.warn(`[migrate] no raw_captures row for ${blob.content_hash}, skipping`)
      continue
    }

    const newKey = shardedKey(blob.content_hash, toBlobContentType(blob.content_type), country)
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
      if (blob.uploaded_at) {
        const { error } = await supabase.storage.from(bucket!).move(blob.s3_key, newKey)
        if (error) throw new Error(error.message)
      } else {
        const oldPath = join(outboxDir, blob.s3_key)
        const newPath = join(outboxDir, newKey)
        await mkdir(dirname(newPath), { recursive: true })
        await rename(oldPath, newPath)
      }
      await pool.query('UPDATE raw_blobs SET s3_key = $1 WHERE content_hash = $2', [newKey, blob.content_hash])
      moved++
    } catch (err) {
      failed++
      console.error(`[migrate] failed for ${blob.content_hash} (${blob.s3_key} -> ${newKey}): ${(err as Error).message}`)
    }
  }

  console.log(
    `${apply ? 'moved' : 'would move'}=${moved} alreadyDone=${alreadyDone} skippedNoCapture=${skippedNoCapture} failed=${failed}`,
  )
  await pool.end()
}

main().catch((err) => {
  console.error(`[migrate] aborted: ${(err as Error).message}`)
  process.exit(1)
})
