// Memory attribution for the production app: which task makes the process
// grow, and is it JS heap (retained data) or native/fragmented memory. The
// host OOM-killed the app repeatedly at 1.5–1.9 GB, and a process dump is not
// reachable from outside the rootless container — so the app logs it itself.
//
// Cheap on purpose: process.memoryUsage() plus a one-line log, only on task
// start/end and when the resident size moved noticeably (or as a slow
// heartbeat). Switch off with ZVG_MEMORY_LOG=0.

const MB = 1024 * 1024
const SAMPLE_INTERVAL_MS = 60_000
const MIN_DELTA_MB = 64
const HEARTBEAT_MS = 10 * 60_000

const running = new Set<string>()
let lastLoggedRssMb = 0
let lastLoggedAt = 0

function enabled(): boolean {
  return process.env.ZVG_MEMORY_LOG !== '0'
}

function formatMemory(label: string): { line: string; rssMb: number } {
  const usage = process.memoryUsage()
  const mb = (bytes: number) => Math.round(bytes / MB)
  const active = running.size > 0 ? [...running].sort().join(',') : '-'
  return {
    rssMb: mb(usage.rss),
    line: `[memory] ${label} rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB heapTotal=${mb(usage.heapTotal)}MB external=${mb(usage.external)}MB arrayBuffers=${mb(usage.arrayBuffers)}MB running=${active}`,
  }
}

function emit(label: string): void {
  const { line, rssMb } = formatMemory(label)
  lastLoggedRssMb = rssMb
  lastLoggedAt = Date.now()
  console.log(line)
}

/** Logs the current memory use together with the task event that caused it. */
export function logTaskMemory(task: string, phase: 'start' | 'end'): void {
  if (phase === 'start') running.add(task)
  else running.delete(task)
  if (enabled()) emit(`task=${task} ${phase}`)
}

/** Periodic sampler: logs when RSS moved by at least MIN_DELTA_MB since the
 *  last line, plus a slow heartbeat so a flat series is visible too. */
export function startMemorySampler(): ReturnType<typeof setInterval> | null {
  if (!enabled()) return null
  emit('boot')
  const timer = setInterval(() => {
    const { rssMb } = formatMemory('sample')
    const moved = Math.abs(rssMb - lastLoggedRssMb) >= MIN_DELTA_MB
    if (moved || Date.now() - lastLoggedAt >= HEARTBEAT_MS) emit(moved ? 'sample' : 'heartbeat')
  }, SAMPLE_INTERVAL_MS)
  timer.unref()
  return timer
}
