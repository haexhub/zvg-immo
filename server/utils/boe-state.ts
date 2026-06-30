// Persistent BOE crawler state on disk. Today only the captcha cooldown is
// tracked, but lastCaptchaAt is kept so the /api/_health/boe endpoint can
// surface when the IP was last blocked.
//
// Why on disk: BOE captchas appear to be IP-level bans on the order of hours
// or longer. The in-process cooldown survives 30 min and resets on container
// restart — so each restart used to ping BOE again, re-trigger the captcha,
// and arm a fresh cooldown. Persisting the cooldown across restarts breaks
// that loop.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STATE_PATH = join(process.cwd(), '.cache_zvg', 'boe-state.json')

export interface BoeState {
  /** Unix ms — `boeFetch` refuses to send until `Date.now() >= captchaCooldownUntil`. */
  captchaCooldownUntil: number
  /** Unix ms of the most recent captcha sighting, for diagnostics. */
  lastCaptchaAt: number | null
}

export const EMPTY_BOE_STATE: BoeState = { captchaCooldownUntil: 0, lastCaptchaAt: null }

export async function readBoeState(): Promise<BoeState> {
  try {
    const buf = await readFile(STATE_PATH, 'utf8')
    const parsed = JSON.parse(buf) as Partial<BoeState>
    return {
      captchaCooldownUntil:
        typeof parsed.captchaCooldownUntil === 'number' ? parsed.captchaCooldownUntil : 0,
      lastCaptchaAt:
        typeof parsed.lastCaptchaAt === 'number' ? parsed.lastCaptchaAt : null,
    }
  } catch {
    return { ...EMPTY_BOE_STATE }
  }
}

export async function writeBoeState(state: BoeState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(state))
  await rename(tmp, STATE_PATH)
}
