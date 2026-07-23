// Uploads auction photos (extracted by native-images.ts/pdf-images.ts) to a
// public-read Supabase Storage bucket, so /api/auction-image can fall back to
// serving them there once the local cache (.cache_zvg/images) is gone. Same
// best-effort contract as storage-uploader.ts: never throws, no-op without a
// configured bucket or Supabase client — the local file the caller already
// wrote stays the source of truth for that run either way.

import { getServiceClient } from './supabase'

const CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function bucketName(): string | null {
  return (useRuntimeConfig().imagesBucket as string | undefined) || null
}

/**
 * Whether an images bucket is configured. Lets callers skip the work of
 * reading files off disk just to hand them to a `uploadImage` that would
 * no-op anyway (the default, until the infra step creates the bucket).
 */
export function imagesBucketConfigured(): boolean {
  return bucketName() !== null
}

function extOf(key: string): string {
  return (key.split('.').pop() ?? '').toLowerCase()
}

/** Content-type for a filename/key by its extension, or the generic binary
 *  fallback for an unrecognized one. Shared with callers that need to label
 *  bytes read off disk (e.g. sending a photo to an LLM as an image part). */
export function mimeTypeFor(key: string): string {
  return CONTENT_TYPE[extOf(key)] ?? 'application/octet-stream'
}

/**
 * Public URL for `key` (e.g. `<platform>/<externalId>/<filename>`) in the
 * images bucket, or null when the bucket or the browser-facing Supabase URL
 * isn't configured — callers should fall back to another source in that case.
 */
export function imagePublicUrl(key: string): string | null {
  const bucket = bucketName()
  if (!bucket) return null
  const base = (useRuntimeConfig().public.supabaseUrl as string | undefined)?.replace(/\/+$/, '')
  if (!base) return null
  return `${base}/storage/v1/object/public/${bucket}/${key}`
}

/**
 * Uploads `bytes` to `key` in the images bucket. Returns whether the upload
 * succeeded; never throws. `upsert: true` because filenames are
 * content-addressed (same bytes → same key), so re-uploads are idempotent.
 */
export async function uploadImage(bytes: Buffer, key: string): Promise<boolean> {
  const bucket = bucketName()
  if (!bucket) return false
  const supabase = getServiceClient()
  if (!supabase) return false
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(key, bytes, { contentType: mimeTypeFor(key), upsert: true })
    if (error) throw new Error(error.message)
    return true
  } catch (err) {
    console.warn(`[image-storage] upload failed for ${key}: ${(err as Error).message}`)
    return false
  }
}
