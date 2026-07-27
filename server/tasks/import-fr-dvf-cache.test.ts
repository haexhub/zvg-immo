import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tmp: string | null = null

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.resetModules()
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

function csv(): string {
  return [
    'id_mutation;date_mutation;valeur_fonciere;code_commune;commune;type_local;surface_reelle_bati;surface_terrain;latitude;longitude',
    'm1;2025-01-01;450000;75056;Paris;Maison;100;300;48,8566;2,3522',
    'm2;2025-01-02;0;75056;Paris;Maison;100;300;48,8566;2,3522',
  ].join('\n')
}

describe('runImportFrDvfCache', () => {
  it('imports a CSV into the requested cache path and returns a summary', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    tmp = await mkdtemp(join(tmpdir(), 'zvg-dvf-task-'))
    const csvPath = join(tmp, 'dvf.csv')
    const cachePath = join(tmp, 'fr-dvf.json')
    await writeFile(csvPath, csv())

    const { runImportFrDvfCache } = await import('./import-fr-dvf-cache')
    const summary = await runImportFrDvfCache({
      csvPath,
      cachePath,
      sourceVersion: 'fixture-2025',
      generatedAt: '2026-07-26T00:00:00.000Z',
    })

    expect(summary).toEqual({
      csvPath,
      cachePath,
      sourceVersion: 'fixture-2025',
      rows: 2,
      normalized: 1,
      dropped: 1,
      generatedAt: '2026-07-26T00:00:00.000Z',
    })
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({
      sourceVersion: 'fixture-2025',
      transactions: [{ id: 'm1', communeCode: '75056' }],
    })
  })

  it('requires csvPath', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { runImportFrDvfCache } = await import('./import-fr-dvf-cache')

    await expect(runImportFrDvfCache({ csvPath: '   ' })).rejects.toThrow('csvPath is required')
  })

  it('uses a deterministic sourceVersion fallback from generatedAt', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    tmp = await mkdtemp(join(tmpdir(), 'zvg-dvf-task-'))
    const csvPath = join(tmp, 'dvf.csv')
    const cachePath = join(tmp, 'fr-dvf.json')
    await writeFile(csvPath, csv())

    const { runImportFrDvfCache } = await import('./import-fr-dvf-cache')
    const summary = await runImportFrDvfCache({
      csvPath,
      cachePath,
      generatedAt: '2026-07-26T12:34:56.000Z',
    })

    expect(summary.sourceVersion).toBe('fr-dvf-2026-07-26')
  })
})
