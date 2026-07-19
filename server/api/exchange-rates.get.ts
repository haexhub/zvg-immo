import { getRates } from '../utils/exchange-rate'

// EUR-based rate table (units of currency per 1 EUR), backed by
// exchange-rate.ts's own 24h-TTL disk cache — fetched client-only (see
// composables/useCurrencyDisplay.ts) so the SSR-rendered page never varies
// by the viewer's currency preference.
export default defineEventHandler(async () => {
  return await getRates()
})
