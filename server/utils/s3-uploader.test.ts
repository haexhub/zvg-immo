import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

class FakePutObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}
const sendMock = vi.fn(async (_cmd: FakePutObjectCommand) => ({}))
class FakeS3Client {
  send = sendMock
}
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: FakeS3Client,
  PutObjectCommand: FakePutObjectCommand,
}))

const { drainOutbox } = await import('./s3-uploader')

const S3_RUNTIME_CONFIG = {
  endpoint: 'https://s3.example.com',
  bucket: 'test-bucket',
  accessKey: 'key',
  secretKey: 'secret',
  region: 'eu-central-1',
}

function makeFakePool(rows: Array<{ content_hash: string; s3_key: string; content_type: string }>) {
  const updated: string[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT content_hash, s3_key, content_type FROM raw_blobs')) {
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('UPDATE raw_blobs SET uploaded_at')) {
      updated.push(params[0] as string)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, updated }
}

describe('drainOutbox', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 's3-uploader-test-'))
    sendMock.mockClear()
    sendMock.mockResolvedValue({})
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, s3: S3_RUNTIME_CONFIG }))
    const result = await drainOutbox()
    expect(result).toEqual({ uploaded: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('no-ops when the S3 config is incomplete', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn() } as never)
    vi.stubGlobal('useRuntimeConfig', () => ({
      rawOutboxDir: outboxDir,
      s3: { endpoint: '', bucket: '', accessKey: '', secretKey: '', region: '' },
    }))
    const result = await drainOutbox()
    expect(result).toEqual({ uploaded: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('uploads pending blobs, marks uploaded_at, and deletes the local file', async () => {
    const key = 'ab/abcdef.json.gz'
    const filePath = join(outboxDir, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from('gzip-bytes'))

    const pool = makeFakePool([{ content_hash: 'abcdef', s3_key: key, content_type: 'application/json+gzip' }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, s3: S3_RUNTIME_CONFIG }))

    const result = await drainOutbox()

    expect(result).toEqual({ uploaded: 1, failed: 0 })
    expect(sendMock).toHaveBeenCalledTimes(1)
    const command = sendMock.mock.calls[0]![0]
    expect(command.input).toMatchObject({ Bucket: 'test-bucket', Key: key })
    expect(pool.updated).toEqual(['abcdef'])
    await expect(stat(filePath)).rejects.toThrow()
  })

  it('counts a failed upload without throwing and leaves the local file in place', async () => {
    const key = 'cd/missing.json.gz'
    // Intentionally do not create the outbox file: readFile fails.
    const pool = makeFakePool([{ content_hash: 'missing', s3_key: key, content_type: 'application/json+gzip' }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, s3: S3_RUNTIME_CONFIG }))

    const result = await drainOutbox()

    expect(result).toEqual({ uploaded: 0, failed: 1 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(pool.updated).toEqual([])
  })
})
