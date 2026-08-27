import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const APP_RUNTIME_STATUS_PATH = join(process.cwd(), '.cache_zvg', 'operations', 'app-runtime.json')
const HOST_RESTART_STATE_PATH = join(process.cwd(), '.cache_zvg', 'operations', 'host-restart-state.json')
const HOST_STATUS_PATH = '/app/.ops/host-status.json'
const MAX_STARTS = 20
const MAX_ERROR_LENGTH = 1_000
// systemd's NRestarts (host.app.restartCount below) is a lifetime counter
// that never resets on its own, so gating "is the host healthy right now" on
// its raw value means the badge stays red forever after the third restart
// ever, however long ago that was. This tracks restarts within a recent
// window instead, mirroring recentStarts/restarts15m on the app side.
const RESTART_WINDOW_MS = 15 * 60 * 1_000
const MAX_RESTART_SAMPLES = 20

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
    /** Restarts observed within the last {@link RESTART_WINDOW_MS}, derived
     * locally from the raw lifetime `restartCount` — see the comment there. */
    recentRestartCount: number
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

/** The reporter payload's raw app shape, before `recentRestartCount` is derived locally (see {@link trackHostRestarts}). */
type RawHostAppStatus = Omit<NonNullable<HostOperationsStatus['app']>, 'recentRestartCount'>

function coerceService(value: unknown, database = false): RawHostAppStatus | HostOperationsStatus['database'] {
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

interface HostRestartState {
  lastCount: number
  increases: string[]
}

const EMPTY_RESTART_STATE: HostRestartState = { lastCount: 0, increases: [] }

async function readHostRestartState(): Promise<HostRestartState> {
  try {
    const raw = JSON.parse(await readFile(HOST_RESTART_STATE_PATH, 'utf8')) as Record<string, unknown>
    const lastCount = asNonNegativeInteger(raw.lastCount) ?? 0
    const increases = Array.isArray(raw.increases)
      ? raw.increases.map(asIsoDate).filter((entry): entry is string => !!entry).slice(-MAX_RESTART_SAMPLES)
      : []
    return { lastCount, increases }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[operations-status] could not read host restart state: ${(err as Error).message}`)
    }
    return { ...EMPTY_RESTART_STATE }
  }
}

async function writeHostRestartState(state: HostRestartState): Promise<void> {
  try {
    await mkdir(dirname(HOST_RESTART_STATE_PATH), { recursive: true })
    // Unlike app-runtime.json (written rarely, on boot/migration events),
    // this is written on every /api/settings/operations poll — a pid-only
    // temp suffix can collide between two concurrent requests in the same
    // process (e.g. two open admin tabs), so this also mixes in a random
    // component per write.
    const temporaryPath = `${HOST_RESTART_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await rename(temporaryPath, HOST_RESTART_STATE_PATH)
  } catch (err) {
    console.warn(`[operations-status] could not write host restart state: ${(err as Error).message}`)
  }
}

/** Turns the raw lifetime `restartCount` into "restarts observed in the last
 * {@link RESTART_WINDOW_MS}" by diffing against the last-seen count. */
async function trackHostRestarts(currentCount: number | null, now = new Date()): Promise<number> {
  if (currentCount === null) return 0
  const state = await readHostRestartState()
  const delta = Math.max(0, currentCount - state.lastCount)
  const increases = [...state.increases, ...Array<string>(delta).fill(now.toISOString())].slice(-MAX_RESTART_SAMPLES)
  if (currentCount !== state.lastCount) {
    await writeHostRestartState({ lastCount: currentCount, increases })
  }
  const windowStart = now.getTime() - RESTART_WINDOW_MS
  return increases.filter((entry) => new Date(entry).getTime() >= windowStart).length
}

/** Reads the host-side reporter output. It is intentionally optional: local
 * development and older deployments work without it and show "unavailable". */
export async function getHostOperationsStatus(): Promise<HostOperationsStatus> {
  try {
    const raw = JSON.parse(await readFile(HOST_STATUS_PATH, 'utf8')) as Record<string, unknown>
    const failures = Array.isArray(raw.recentFailures)
      ? raw.recentFailures.map((entry) => asShortString(entry, MAX_ERROR_LENGTH)).filter((entry): entry is string => !!entry).slice(0, 10)
      : []
    const app = coerceService(raw.app) as RawHostAppStatus | null
    return {
      available: true,
      reportedAt: asIsoDate(raw.reportedAt),
      app: app ? { ...app, recentRestartCount: await trackHostRestarts(app.restartCount) } : null,
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
