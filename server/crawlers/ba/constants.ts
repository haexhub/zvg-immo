export const BA_API_BASE = 'https://portalfo1.pravosudje.ba/vstvfo-api'
export const BA_WEB_BASE = 'https://pravosudje.ba'
export const COUNTRY = 'ba'
export const PLATFORM_ID = 'ba-pravosudje'
// BAM (Konvertibilna marka) is pegged to EUR at a fixed rate set by the BiH Currency Board
export const BAM_PER_EUR = 1.95583
export const BA_REGIONS = [{ code: 'all', name: 'Bosnien-Herzegowina' }] as const

// RS court institution IDs — these use /S/ in web URLs; all others use /B/
const RS_INS_IDS = new Set([71, 80, 84, 89, 90, 161, 162, 164, 179])

export function entityCode(insId: number): 'B' | 'S' {
  return RS_INS_IDS.has(insId) ? 'S' : 'B'
}
