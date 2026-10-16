// Per-auction photo pipeline of an enrich run: mirror native image URLs,
// mine document candidates, archive the new bytes, and derive the curated
// photo set plus its photo-pipeline state. Split out of enrich-worker.ts so
// the worker loop stays an orchestrator and this step is testable on its own.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import type { AuctionFetchState } from '~/server/utils/auction-fetch-state'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractDocumentPhotos } from '~/server/utils/extract/document-images'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '~/server/utils/image-storage'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { archivePhotoBlob, type DocumentIdentity } from '~/server/utils/raw-archive'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const CONTENT_HASH_IMAGE_FILE_RE = /^([0-9a-f]{8,32})\.(?:jpe?g|png|webp)$/i
function imageContentHashFromFilename(name: string): string | null {
  return CONTENT_HASH_IMAGE_FILE_RE.exec(name)?.[1] ?? null
}

export interface EnrichPhotoContext {
  at: string
  scopedForce: boolean
  needsPhotoBackfill: (a: Auction) => boolean
  nativePhotoUrls: (a: Auction) => string[]
  targetPhotoPipelineVersion: (a: Auction) => number
}

export interface EnrichPhotoOutcome {
  curatedPhotos: CuratedPhoto[] | undefined
  photoState: {
    photosCheckedAt: string | null
    photoFailures: number
    photoPipelineVersion: number | null
    photoAttempted: boolean
  }
  /** Whether document candidates were mined (counts toward photoExtractions). */
  minedDocuments: boolean
  /** Displayed photos after this pass (counts toward photosTotal). */
  photoCount: number
  /** Joined source failures, reported by the caller as one run error. */
  error?: string
}

/**
 * Native URLs stay in `auction.photoUrls` for display; `extraction.photos`
 * stores document-derived images only after dropping exact byte duplicates
 * whose content hash matches a mirrored native image.
 */
export async function processEnrichPhotos(
  a: Auction,
  priorEntry: AuctionExtraction | undefined,
  priorFetchState: AuctionFetchState | undefined,
  documentIdentity: DocumentIdentity,
  ctx: EnrichPhotoContext,
): Promise<EnrichPhotoOutcome> {
  const { at } = ctx
  let photosCheckedAt = priorFetchState?.photosCheckedAt ?? null
  let photoFailures = priorFetchState?.photoFailures ?? 0
  let photoPipelineVersion = priorFetchState?.photoPipelineVersion ?? null
  const photoAttempted = ctx.needsPhotoBackfill(a) && isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)
  if (!photoAttempted) {
    return {
      curatedPhotos: priorEntry?.photos?.map(normalizePhoto),
      photoState: { photosCheckedAt, photoFailures, photoPipelineVersion, photoAttempted },
      minedDocuments: false,
      photoCount: 0,
    }
  }
  const destDir = join(IMAGES_DIR, a.platform, a.externalId)
  const priorPhotos = priorEntry?.photos?.map(normalizePhoto) ?? []
  const targetVersion = ctx.targetPhotoPipelineVersion(a)
  const rebuildingPhotoSet = ctx.scopedForce || (priorFetchState?.photoPipelineVersion ?? 1) < targetVersion
  let photos = rebuildingPhotoSet ? [] : priorPhotos.map((photo) => photo.file)
  let newlyDownloadedPhotos: string[] = []
  const nativeFotoUrls = ctx.nativePhotoUrls(a)
  const nativePhotoHashes = new Set<string>()
  const addNewlyDownloadedPhotos = (names: readonly string[]) => {
    newlyDownloadedPhotos = [...new Set([...newlyDownloadedPhotos, ...names])]
  }
  const addDisplayedPhotos = (names: readonly string[]) => {
    photos = [...new Set([...photos, ...names])]
  }
  // Native gallery download and document/PDF mining are independent
  // sources — each gets its own try/catch so one throwing (a
  // transient upstream problem) doesn't discard photos the other
  // already found, and doesn't skip the other source entirely.
  const sourceErrors: string[] = []
  if (nativeFotoUrls.length > 0) {
    try {
      const nativePhotos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
      addNewlyDownloadedPhotos(nativePhotos)
      addDisplayedPhotos(nativePhotos)
      for (const name of nativePhotos) {
        const hash = imageContentHashFromFilename(name)
        if (hash) nativePhotoHashes.add(hash)
      }
    } catch (err) {
      sourceErrors.push((err as Error).message)
    }
  }
  const minedDocuments = a.attachments.length > 0
  if (minedDocuments) {
    try {
      const documentPhotos = await extractDocumentPhotos(a.attachments, {
        destDir,
      })
      addNewlyDownloadedPhotos(documentPhotos)
      addDisplayedPhotos(
        documentPhotos.filter((name) => {
          const hash = imageContentHashFromFilename(name)
          return !hash || !nativePhotoHashes.has(hash)
        }),
      )
    } catch (err) {
      sourceErrors.push((err as Error).message)
    }
  }
  const photoCount = photos.length
  try {
    // Archive every freshly downloaded photo's raw bytes (kind='photo')
    // and mirror it into the images bucket (WP-4) when configured, so
    // /api/auction-image can fall back to Supabase once the local cache
    // is gone. uploadImage never throws and no-ops without a configured
    // bucket.
    for (const name of [...new Set(newlyDownloadedPhotos)]) {
      const contentType = mimeTypeFor(name)
      // The downloaders only write jpeg/png/webp names; anything else is a
      // pipeline bug, surfaced instead of archived under a fake image type.
      if (contentType === 'application/octet-stream') {
        sourceErrors.push(`unbekannter Bildtyp: ${name}`)
        continue
      }
      const bytes = await readFile(join(destDir, name))
      await archivePhotoBlob(bytes, contentType, documentIdentity, at)
      if (imagesBucketConfigured()) await uploadImage(bytes, `${a.platform}/${a.externalId}/${name}`)
    }
  } catch (err) {
    sourceErrors.push((err as Error).message)
  }
  let error: string | undefined
  if (sourceErrors.length > 0) {
    photoFailures++
    error = sourceErrors.join('; ')
    if (photos.length === 0 && priorPhotos.length > 0) {
      photos = priorPhotos.map((photo) => photo.file)
    }
  } else {
    // Completed without throwing — "checked", regardless of whether
    // any photos were actually found (a legitimately photo-less
    // listing/document stops being retried from here on).
    photosCheckedAt = at
    photoFailures = 0
    photoPipelineVersion = targetVersion
  }
  return {
    curatedPhotos: photos.length > 0
      ? photos.map((name) => priorPhotos.find((photo) => photo.file === name) ?? normalizePhoto(name))
      : undefined,
    photoState: { photosCheckedAt, photoFailures, photoPipelineVersion, photoAttempted },
    minedDocuments,
    photoCount,
    ...(error ? { error } : {}),
  }
}
