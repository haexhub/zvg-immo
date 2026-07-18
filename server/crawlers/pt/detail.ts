import { fetch } from 'undici'
import type { Auction } from '~/types/auction'
import { PT_BASE, LIST_PATH, UA } from './constants'
import { eLeiloesAgent } from './agent'

/** Subset of the per-evento payload from GET /api/Eventos/<referencia> —
 *  much richer than the list response (description, areas, gallery, coords). */
export interface PtEventoDetail {
  descricao: string | null
  observacoes: string | null
  /** Usable/living area in m² (0 for pure land lots). */
  areaUtilPrivativa: number | null
  /** Total area in m² — for Rústico/land lots this is the plot size. */
  areaTotal: number | null
  fotos: { image: string | null }[] | null
  /** Decimal-degree coordinates, serialised as strings by the API. */
  coordenadasLAT: string | null
  coordenadasLON: string | null
  /** Real court case number/court, absent from the list response (which only
   *  has the e-leilões `referencia`). */
  processoNumero: string | null
  processoTribunal: string | null
}

export async function fetchEventoDetail(referencia: string): Promise<PtEventoDetail> {
  const res = await fetch(`${PT_BASE}${LIST_PATH}${encodeURIComponent(referencia)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
    dispatcher: eLeiloesAgent,
  })
  if (!res.ok) throw new Error(`e-leiloes.pt Eventos detail fetch failed for ${referencia}: ${res.status}`)
  const data = (await res.json()) as { item?: PtEventoDetail }
  if (!data.item) throw new Error(`e-leiloes.pt Eventos detail for ${referencia}: no item in response`)
  return data.item
}

/** Multiline text: keep the paragraph structure, just trim. */
function text(s: string | null | undefined): string | null {
  const t = s?.trim()
  return t || null
}

function positive(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null
}

export function applyDetail(auction: Auction, item: PtEventoDetail): void {
  const description = [text(item.descricao), text(item.observacoes)].filter(Boolean).join('\n\n')
  if (description) auction.description = description

  // Replace the e-leilões referencia (already used above it as the fetch key
  // in enrichOne) with the real court case number/court once known.
  const processoNumero = text(item.processoNumero)
  if (processoNumero) auction.caseNumber = processoNumero
  const processoTribunal = text(item.processoTribunal)
  if (processoTribunal) auction.authority = processoTribunal

  // areaUtilPrivativa is the usable/living area of the built unit; pure land
  // lots (Rústico/Terreno) carry 0 there and the plot size in areaTotal.
  const livingArea = positive(item.areaUtilPrivativa)
  const totalArea = positive(item.areaTotal)
  if (livingArea != null) auction.sourceLivingAreaSqm = livingArea
  else if (totalArea != null) auction.sourceLandAreaSqm = totalArea

  const photoUrls = (item.fotos ?? [])
    .map((f) => f.image)
    .filter((p): p is string => Boolean(p))
    .map((p) => `${PT_BASE}/${p}`)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
  }

  const lat = Number(item.coordenadasLAT)
  const lng = Number(item.coordenadasLON)
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
    auction.lat = lat
    auction.lng = lng
  }
}
