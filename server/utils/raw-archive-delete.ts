import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { and, eq, exists, inArray, notExists, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { createError } from 'h3'
import {
  artifactBlobs,
  artifactCaptures,
  artifactVersionItems,
  artifactVersions,
  auctions,
} from '../db/schema'
import { getDb } from './db'
import { getServiceClient } from './supabase'

interface BlobRef {
  contentHash: string
  s3Key: string
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

export async function rollbackQuietly(client: PoolClient): Promise<void> {
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

  const db = getDb()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }

  let orphanedBlobs: BlobRef[] = []
  let captures = 0
  let documentSets = 0
  let documentSetItems = 0
  try {
    ;({ orphanedBlobs, captures, documentSets, documentSetItems } = await db.transaction(async (tx) => {
      // A capture/document-set row scoped to this country's auctions —
      // mirrors the `USING auctions a` joins below, since none of these
      // child tables carry their own `country` column.
      const belongsToCountry = (platform: AnyPgColumn, externalId: AnyPgColumn) =>
        exists(
          tx.select({ one: sql`1` }).from(auctions).where(and(
            eq(auctions.platform, platform),
            eq(auctions.externalId, externalId),
            eq(auctions.country, country),
          )),
        )

      const candidates = await tx.selectDistinct({ contentHash: artifactBlobs.contentHash, s3Key: artifactBlobs.s3Key })
        .from(artifactBlobs)
        .where(or(
          exists(
            tx.select({ one: sql`1` }).from(artifactCaptures)
              .innerJoin(auctions, and(eq(auctions.platform, artifactCaptures.platform), eq(auctions.externalId, artifactCaptures.externalId)))
              .where(and(eq(auctions.country, country), eq(artifactCaptures.contentHash, artifactBlobs.contentHash))),
          ),
          exists(
            tx.select({ one: sql`1` }).from(artifactVersions)
              .innerJoin(auctions, and(eq(auctions.platform, artifactVersions.platform), eq(auctions.externalId, artifactVersions.externalId)))
              .innerJoin(artifactVersionItems, eq(artifactVersionItems.setId, artifactVersions.id))
              .where(and(eq(auctions.country, country), eq(artifactVersionItems.contentHash, artifactBlobs.contentHash))),
          ),
        ))

      const [itemCount] = await tx.select({ count: sql<string>`count(*)` })
        .from(artifactVersions)
        .innerJoin(auctions, and(eq(auctions.platform, artifactVersions.platform), eq(auctions.externalId, artifactVersions.externalId)))
        .innerJoin(artifactVersionItems, eq(artifactVersionItems.setId, artifactVersions.id))
        .where(eq(auctions.country, country))

      const deletedSets = await tx.delete(artifactVersions)
        .where(belongsToCountry(artifactVersions.platform, artifactVersions.externalId))

      // fk_auction_details_artifact_version cascades the delete above into
      // auction_details, but only into the versions that actually reference a
      // manifest — the first, listing-only version (artifact_version_id NULL)
      // survives. Whenever the cascade took the is_latest row and left such a
      // version behind, the identity is left with *no* live row at all, and
      // every read path keys off is_latest (WP-0), so the auction would serve
      // empty details until it happens to be crawled and reprocessed again.
      // Promote the newest surviving non-trial version instead; a trial is
      // never eligible to go live implicitly.
      await tx.execute(sql`
        UPDATE auction_details SET is_latest = true
        WHERE id IN (
          SELECT DISTINCT ON (ad.platform, ad.external_id) ad.id
          FROM auction_details ad
          JOIN auctions a ON a.platform = ad.platform AND a.external_id = ad.external_id
          WHERE a.country = ${country}
            AND ad.is_trial = false
            AND NOT EXISTS (
              SELECT 1 FROM auction_details live
              WHERE live.platform = ad.platform AND live.external_id = ad.external_id AND live.is_latest
            )
          ORDER BY ad.platform, ad.external_id, ad.version DESC
        )
      `)

      const deletedCaptures = await tx.delete(artifactCaptures)
        .where(belongsToCountry(artifactCaptures.platform, artifactCaptures.externalId))

      const hashes = candidates.map((row) => row.contentHash)
      let orphaned: BlobRef[] = []
      if (hashes.length > 0) {
        orphaned = await tx.delete(artifactBlobs)
          .where(and(
            inArray(artifactBlobs.contentHash, hashes),
            notExists(tx.select({ one: sql`1` }).from(artifactCaptures).where(eq(artifactCaptures.contentHash, artifactBlobs.contentHash))),
            notExists(tx.select({ one: sql`1` }).from(artifactVersionItems).where(eq(artifactVersionItems.contentHash, artifactBlobs.contentHash))),
          ))
          .returning({ contentHash: artifactBlobs.contentHash, s3Key: artifactBlobs.s3Key })
      }

      return {
        orphanedBlobs: orphaned,
        captures: deletedCaptures.rowCount ?? 0,
        documentSets: deletedSets.rowCount ?? 0,
        documentSetItems: Number(itemCount?.count ?? 0),
      }
    }))
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: `Archiv konnte nicht gelöscht werden: ${(err as Error).message}`,
    })
  }

  const keys = orphanedBlobs.map((row) => row.s3Key)
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
