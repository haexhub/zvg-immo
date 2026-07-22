import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServiceClient } from './supabase'

vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const uploadMock = vi.fn(async (..._args: unknown[]): Promise<{ error: { message: string } | null }> => ({
  error: null,
}))
const fakeSupabase = { storage: { from: vi.fn(() => ({ upload: uploadMock })) } }

const { imagePublicUrl, uploadImage } = await import('./image-storage')

describe('imagePublicUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns null without a bucket name', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: '', public: { supabaseUrl: 'http://localhost:8000' } }))
    expect(imagePublicUrl('de/123/abc.jpg')).toBeNull()
  })

  it('returns null without a public Supabase URL', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: 'zvg-immo-images', public: { supabaseUrl: '' } }))
    expect(imagePublicUrl('de/123/abc.jpg')).toBeNull()
  })

  it('builds the public object URL, stripping a trailing slash from the base', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      imagesBucket: 'zvg-immo-images',
      public: { supabaseUrl: 'http://localhost:8000/' },
    }))
    expect(imagePublicUrl('de/123/abc.jpg')).toBe(
      'http://localhost:8000/storage/v1/object/public/zvg-immo-images/de/123/abc.jpg',
    )
  })
})

describe('uploadImage', () => {
  beforeEach(() => {
    uploadMock.mockClear()
    uploadMock.mockResolvedValue({ error: null })
    fakeSupabase.storage.from.mockClear()
    vi.mocked(getServiceClient).mockReturnValue(fakeSupabase as never)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('no-ops without a bucket name', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: '' }))
    expect(await uploadImage(Buffer.from('x'), 'de/123/abc.jpg')).toBe(false)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('no-ops when Supabase is not configured', async () => {
    vi.mocked(getServiceClient).mockReturnValue(null)
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: 'zvg-immo-images' }))
    expect(await uploadImage(Buffer.from('x'), 'de/123/abc.jpg')).toBe(false)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('uploads with a content-type derived from the extension', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: 'zvg-immo-images' }))
    const ok = await uploadImage(Buffer.from('x'), 'de/123/abc.png')
    expect(ok).toBe(true)
    expect(fakeSupabase.storage.from).toHaveBeenCalledWith('zvg-immo-images')
    expect(uploadMock).toHaveBeenCalledWith('de/123/abc.png', expect.any(Buffer), {
      contentType: 'image/png',
      upsert: true,
    })
  })

  it('returns false without throwing when Supabase rejects the upload', async () => {
    uploadMock.mockResolvedValueOnce({ error: { message: 'bucket not found' } })
    vi.stubGlobal('useRuntimeConfig', () => ({ imagesBucket: 'zvg-immo-images' }))
    expect(await uploadImage(Buffer.from('x'), 'de/123/abc.jpg')).toBe(false)
  })
})
