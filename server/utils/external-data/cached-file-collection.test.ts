import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearCachedFileCollections, readCachedFileCollection } from './cached-file-collection'

let tmp: string | null = null

beforeEach(() => {
  clearCachedFileCollections()
})

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

async function cacheFile(content: string): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'cached-collection-'))
  const path = join(tmp, 'cache.json')
  await writeFile(path, content)
  return path
}

describe('readCachedFileCollection', () => {
  it('parses once for repeated reads of an unchanged file', async () => {
    const path = await cacheFile('{"zones":[1]}')
    let loads = 0
    const load = async (target: string) => {
      loads++
      return JSON.parse(await readFile(target, 'utf8')) as unknown
    }

    const first = await readCachedFileCollection(path, load)
    const second = await readCachedFileCollection(path, load)

    expect(loads).toBe(1)
    expect(second).toBe(first)
  })

  it('shares one parse between concurrent first-time readers', async () => {
    // The production failure this guards: 45 per-auction enrichment triggers
    // hit the same 182 MB cache at once, each starting its own parse.
    const path = await cacheFile('{"zones":[]}')
    let loads = 0
    const load = async () => {
      loads++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { zones: [] }
    }

    const results = await Promise.all(
      Array.from({ length: 20 }, () => readCachedFileCollection(path, load)),
    )

    expect(loads).toBe(1)
    expect(new Set(results).size).toBe(1)
  })

  it('reloads after the file changed', async () => {
    const path = await cacheFile('{"generation":1}')
    const load = async (target: string) =>
      JSON.parse(await readFile(target, 'utf8')) as { generation: number }

    expect((await readCachedFileCollection(path, load)).generation).toBe(1)
    await writeFile(path, '{"generation":22}')
    expect((await readCachedFileCollection(path, load)).generation).toBe(22)
  })

  it('keeps separate entries per cache key', async () => {
    const path = await cacheFile('{}')
    const loads: string[] = []
    const load = async (version: string) => {
      loads.push(version)
      return { version }
    }

    const a = await readCachedFileCollection(path, () => load('a'), `${path} a`)
    const b = await readCachedFileCollection(path, () => load('b'), `${path} b`)

    expect(loads).toEqual(['a', 'b'])
    expect(a).not.toBe(b)
  })

  it('propagates a missing file instead of serving a stale collection', async () => {
    const path = await cacheFile('{"zones":[]}')
    await readCachedFileCollection(path, async () => ({ zones: [] }))
    await rm(path)

    await expect(readCachedFileCollection(path, async () => ({ zones: [] }))).rejects.toThrow(/ENOENT/)
  })

  it('does not cache a failed load', async () => {
    const path = await cacheFile('{}')
    let loads = 0
    const load = async () => {
      loads++
      if (loads === 1) throw new Error('corrupt')
      return { ok: true }
    }

    await expect(readCachedFileCollection(path, load)).rejects.toThrow('corrupt')
    await expect(readCachedFileCollection(path, load)).resolves.toEqual({ ok: true })
    expect(loads).toBe(2)
  })
})
