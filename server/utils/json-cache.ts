import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonCache<T extends object>(
  path: string,
  empty: () => T,
  logPrefix: string,
): Promise<T> {
  let buf: string
  try {
    buf = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    console.warn(`[${logPrefix}] failed to read ${path}: ${(err as Error).message}`)
    return empty()
  }
  try {
    const parsed = JSON.parse(buf) as unknown
    if (parsed && typeof parsed === 'object') return parsed as T
  } catch (err) {
    console.warn(`[${logPrefix}] corrupt JSON at ${path}: ${(err as Error).message}`)
  }
  return empty()
}

export async function writeJsonCache(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}
