import { afterEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, string>()

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => { files.set(path, content) }),
  rename: vi.fn(async (from: string, to: string) => {
    files.set(to, files.get(from)!)
    files.delete(from)
  }),
}))

function reportRestartCount(restartCount: number): void {
  files.set('/app/.ops/host-status.json', JSON.stringify({
    reportedAt: '2026-10-13T10:00:00.000Z',
    app: { activeState: 'active', subState: 'running', restartCount, exitCode: 0, startedAt: '2026-10-13T09:00:00.000Z' },
  }))
}

afterEach(() => {
  files.clear()
})

describe('getHostOperationsStatus restart tracking', () => {
  it('treats the first observed lifetime restart count as a baseline, then counts increases', async () => {
    const { getHostOperationsStatus } = await import('./operations-status')

    reportRestartCount(7)
    expect((await getHostOperationsStatus()).app?.recentRestartCount).toBe(0)

    reportRestartCount(9)
    expect((await getHostOperationsStatus()).app?.recentRestartCount).toBe(2)
  })
})
