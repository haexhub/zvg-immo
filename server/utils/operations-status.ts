import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const APP_RUNTIME_STATUS_PATH = join(process.cwd(), '.cache_zvg', 'operations', 'app-runtime.json')
const HOST_STATUS_PATH = '/app/.ops/host-status.json'
const MAX_STARTS = 20
const MAX_ERROR_LENGTH = 1_000

export type MigrationStatus = 'pending' | 'running' | 'ready' | 'failed'

export interface AppRuntimeStatus {
  startedAt: string | null
  recentStarts: string[]
  migration: {
    status: MigrationStatus
    updatedAt: string | null
    error: string | null
  }
}

export interface HostOperationsStatus {
  available: boolean
  reportedAt: string | null
  app: {
    activeState: string | null
    subState: string | null
    restartCount: number | null
    exitCode: number | null
    startedAt: string | null
  } | null
  database: {
    activeState: string | null
    subState: string | null
    sharedMemoryBytes: number | null
  } | null
  recentFailures: string[]
}

const EMPTY_APP_STATUS: AppRuntimeStatus = {
  startedAt: null,
  recentStarts: [],
  migration: { status: 'pending', updatedAt: null, error: null },
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return value
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function asShortString(value: unknown, maxLength = 1_000): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : null
}

function coerceAppRuntimeStatus(value: unknown): AppRuntimeStatus {
  if (!value || typeof value !== 'object') return { ...EMPTY_APP_STATUS, migration: { ...EMPTY_APP_STATUS.migration } }
  const raw = value as Record<string, unknown>
  const migration = raw.migration && typeof raw.migration === 'object' ? raw.migration as Record<string, unknown> : {}
  const recentStarts = Array.isArray(raw.recentStarts)
    ? raw.recentStarts.map(asIsoDate).filter((entry): entry is string => !!entry).slice(-MAX_STARTS)
    : []
  return {
    startedAt: asIsoDate(raw.startedAt),
    recentStarts,
    migration: {
      status: ['pending', 'running', 'ready', 'failed'].includes(String(migration.status))
        ? migration.status as MigrationStatus
        : 'pending',
      updatedAt: asIsoDate(migration.updatedAt),
      error: asShortString(migration.error, MAX_ERROR_LENGTH),
    },
  }
}

async function readAppRuntimeStatusFile(): Promise<AppRuntimeStatus> {
  try {
    return coerceAppRuntimeStatus(JSON.parse(await readFile(APP_RUNTIME_STATUS_PATH, 'utf8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[operations-status] could not read app status: ${(err as Error).message}`)
    }
    return { ...EMPTY_APP_STATUS, migration: { ...EMPTY_APP_STATUS.migration } }
  }
}

async function writeAppRuntimeStatus(status: AppRuntimeStatus): Promise<void> {
  try {
    await mkdir(dirname(APP_RUNTIME_STATUS_PATH), { recursive: true })
    const temporaryPath = `${APP_RUNTIME_STATUS_PATH}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, { mode: 0o600 })
    await rename(temporaryPath, APP_RUNTIME_STATUS_PATH)
  } catch (err) {
    console.warn(`[operations-status] could not write app status: ${(err as Error).message}`)
  }
}

/** Records every Nitro process start, retaining a short crash-loop history. */
export async function recordAppStart(now = new Date()): Promise<AppRuntimeStatus> {
  const current = await readAppRuntimeStatusFile()
  const startedAt = now.toISOString()
  const next: AppRuntimeStatus = {
    ...current,
    startedAt,
    recentStarts: [...current.recentStarts, startedAt].slice(-MAX_STARTS),
  }
  await writeAppRuntimeStatus(next)
  return next
}

/** Persists migration progress independently of the database being migrated. */
export async function recordMigrationStatus(status: MigrationStatus, error: unknown = null): Promise<void> {
  const current = await readAppRuntimeStatusFile()
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  await writeAppRuntimeStatus({
    ...current,
    migration: {
      status,
      updatedAt: new Date().toISOString(),
      error: status === 'failed' ? message?.slice(0, MAX_ERROR_LENGTH) ?? 'Unbekannter Fehler' : null,
    },
  })
}

export async function getAppRuntimeStatus(): Promise<AppRuntimeStatus> {
  return await readAppRuntimeStatusFile()
}

function coerceService(value: unknown, database = false): HostOperationsStatus['app'] | HostOperationsStatus['database'] {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (database) {
    return {
      activeState: asShortString(raw.activeState, 80),
      subState: asShortString(raw.subState, 80),
      sharedMemoryBytes: asNonNegativeInteger(raw.sharedMemoryBytes),
    }
  }
  return {
    activeState: asShortString(raw.activeState, 80),
    subState: asShortString(raw.subState, 80),
    restartCount: asNonNegativeInteger(raw.restartCount),
    exitCode: asNonNegativeInteger(raw.exitCode),
    startedAt: asIsoDate(raw.startedAt),
  }
}

/** Reads the host-side reporter output. It is intentionally optional: local
 * development and older deployments work without it and show "unavailable". */
export async function getHostOperationsStatus(): Promise<HostOperationsStatus> {
  try {
    const raw = JSON.parse(await readFile(HOST_STATUS_PATH, 'utf8')) as Record<string, unknown>
    const failures = Array.isArray(raw.recentFailures)
      ? raw.recentFailures.map((entry) => asShortString(entry, MAX_ERROR_LENGTH)).filter((entry): entry is string => !!entry).slice(0, 10)
      : []
    return {
      available: true,
      reportedAt: asIsoDate(raw.reportedAt),
      app: coerceService(raw.app) as HostOperationsStatus['app'],
      database: coerceService(raw.database, true) as HostOperationsStatus['database'],
      recentFailures: failures,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[operations-status] could not read host status: ${(err as Error).message}`)
    }
    return { available: false, reportedAt: null, app: null, database: null, recentFailures: [] }
  }
}
