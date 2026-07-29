import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from '../utils/db'
import { imagesBucketConfigured, uploadImage } from '../utils/image-storage'

vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../utils/image-storage', () => ({
  imagesBucketConfigured: vi.fn(() => true),
  uploadImage: vi.fn(async () => true),
}))

vi.stubGlobal('defineTask', (def: unknown) => def)

// Real cwd cache dir, like pdf-text.test.ts — IMAGES_DIR is resolved at module
// load, so a mocked process.cwd() would not be picked up. The platform prefix is
// unique to this file so a developer's genuinely cached photos are never touched.
const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')
const PLATFORM = 'test-offload-images'

async function seedImage(externalId: string, name: string, bytes = 'x'): Promise<void> {
  const dir = join(IMAGES_DIR, PLATFORM, externalId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
}

async function remaining(externalId: string): Promise<string[]> {
  return await readdir(join(IMAGES_DIR, PLATFORM, externalId)).catch(() => [])
}

/** `rows` = auctions in the serving table, `endedRows` = those past the cutoff. */
function poolReturning(
  rows: Array<{ platform: string; external_id: string }>,
  endedRows = rows,
) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('auction_date_iso <') ? endedRows : rows,
    })),
  }
}

function auction(externalId: string) {
  return { platform: PLATFORM, external_id: externalId }
}

// clearAllMocks() clears calls but keeps implementations, so a mockReturnValue
// from one test would otherwise leak into the next.
beforeEach(() => {
  vi.mocked(imagesBucketConfigured).mockReturnValue(true)
  vi.mocked(uploadImage).mockResolvedValue(true)
})

afterEach(async () => {
  await rm(join(IMAGES_DIR, PLATFORM), { recursive: true, force: true })
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runOffloadImages', () => {
  it('refuses to delete anything while no images bucket is configured', async () => {
    // The local file is the only copy in that case — this guard is the whole
    // reason the task is safe to schedule.
    vi.mocked(imagesBucketConfigured).mockReturnValue(false)
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')]) as never)
    await seedImage('42', 'aabbccdd.jpg')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(result.removed).toBe(0)
    expect(uploadImage).not.toHaveBeenCalled()
    expect(await remaining('42')).toEqual(['aabbccdd.jpg'])
  })

  it('is a no-op without a database instead of treating every auction as orphaned', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await seedImage('42', 'aabbccdd.jpg')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(result.removed).toBe(0)
    expect(uploadImage).not.toHaveBeenCalled()
    expect(await remaining('42')).toEqual(['aabbccdd.jpg'])
  })

  it('uploads then removes the local photos of an ended auction', async () => {
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')]) as never)
    await seedImage('42', 'aabbccdd.jpg', 'photo-bytes')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(uploadImage).toHaveBeenCalledWith(expect.any(Buffer), `${PLATFORM}/42/aabbccdd.jpg`)
    expect(result).toMatchObject({ uploaded: 1, removed: 1, failed: 0 })
    expect(result.freedBytes).toBe('photo-bytes'.length)
    expect(await remaining('42')).toEqual([])
  })

  it('keeps the local file when the upload was not confirmed', async () => {
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')]) as never)
    vi.mocked(uploadImage).mockResolvedValue(false)
    await seedImage('42', 'aabbccdd.jpg')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(result).toMatchObject({ uploaded: 0, removed: 0, failed: 1 })
    expect(await remaining('42')).toEqual(['aabbccdd.jpg'])
  })

  it('leaves a still-running auction alone', async () => {
    // Known to the serving table, but not past the offload cutoff.
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')], []) as never)
    await seedImage('42', 'aabbccdd.jpg')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(result.removed).toBe(0)
    expect(await remaining('42')).toEqual(['aabbccdd.jpg'])
  })

  it('names the reason it is inactive, so a zero run is not mistaken for a healthy one', async () => {
    vi.mocked(imagesBucketConfigured).mockReturnValue(false)
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')]) as never)
    const { offloadInactiveReason } = await import('./offload-images')

    expect(offloadInactiveReason()).toContain('NUXT_IMAGES_BUCKET')

    vi.mocked(imagesBucketConfigured).mockReturnValue(true)
    vi.mocked(getPool).mockReturnValue(null)
    expect(offloadInactiveReason()).toContain('keine Datenbank')

    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')]) as never)
    expect(offloadInactiveReason()).toBeNull()
  })

  it('offloads photos of an auction the serving table no longer knows', async () => {
    // Orphaned cache: it can never be served from disk again, so the date is moot.
    vi.mocked(getPool).mockReturnValue(poolReturning([auction('42')], []) as never)
    await seedImage('999', 'aabbccdd.jpg')
    const { runOffloadImages } = await import('./offload-images')

    const result = await runOffloadImages()

    expect(result).toMatchObject({ uploaded: 1, removed: 1, auctionsOffloaded: 1 })
    expect(await remaining('999')).toEqual([])
  })
})
