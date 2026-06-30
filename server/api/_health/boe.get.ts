// Diagnostics endpoint for the BOE crawler. Returns the persisted cooldown
// state plus the live `lastFetchAt` and a few computed convenience fields so
// "why is Spain empty?" can be answered with a single curl instead of
// digging through `docker logs`.
//
// Example:
//   curl http://localhost:3000/api/_health/boe
//
// Response (example, currently in cooldown):
//   {
//     "disabled": false,
//     "inCooldown": true,
//     "captchaCooldownUntil": 1751299622000,
//     "msUntilFree": 1778000,
//     "lastCaptchaAt": 1751213222000,
//     "lastFetchAt": 1751213222000,
//     "serverTime": "2026-06-30T15:57:02.000Z"
//   }

import { getBoeState, isBoeDisabled } from '../../crawlers/boe/fetch'

export default defineEventHandler(async () => {
  const state = await getBoeState()
  const now = Date.now()
  return {
    disabled: isBoeDisabled(),
    inCooldown: state.captchaCooldownUntil > now,
    captchaCooldownUntil: state.captchaCooldownUntil,
    msUntilFree: Math.max(0, state.captchaCooldownUntil - now),
    lastCaptchaAt: state.lastCaptchaAt,
    lastFetchAt: state.lastFetchAt || null,
    serverTime: new Date(now).toISOString(),
  }
})
