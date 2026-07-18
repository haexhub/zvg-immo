import { fetch } from 'undici'
import type { Auction } from '~/types/auction'
import { PT_BASE, LIST_PATH, MAP_PATH, COUNTRY, UA, REAL_ESTATE_TIPO_ID, PAGE_SIZE } from './constants'
import { clean, parsePtDateTime, parsePtPrice, formatPtPrice } from './text'
import { eLeiloesAgent } from './agent'

interface PtEvento {
  id: number
  referencia: string
  tipoId: number
  dataInicio: string | null
  dataFim: string | null
  cancelado: boolean
  capa: string | null
  titulo: string | null
  valorBase: number | null
  moradaDistrito: string | null
  moradaConcelho: string | null
  moradaFreguesia: string | null
}

interface PtEventosResponse {
  list: PtEvento[]
  pagination: { first: number; rows: number; total: number }
}

interface PtMapaItem {
  id: number
  tipoId: number
  morada: string | null
  moradaNumero: string | null
  moradaAndar: string | null
  moradaConcelho: string | null
  moradaCP: string | null
}

interface PtMapaResponse {
  list: PtMapaItem[]
}

const MAX_PAGES = 150

async function fetchAddressMap(): Promise<Map<number, PtMapaItem>> {
  const url = `${PT_BASE}${MAP_PATH}?tableParams=${encodeURIComponent(JSON.stringify({ filters: null }))}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
    dispatcher: eLeiloesAgent,
  })
  if (!res.ok) throw new Error(`e-leiloes.pt EventosMapa fetch failed: ${res.status}`)
  const data = (await res.json()) as PtMapaResponse
  const map = new Map<number, PtMapaItem>()
  for (const item of data.list) {
    if (item.tipoId === REAL_ESTATE_TIPO_ID) map.set(item.id, item)
  }
  return map
}

async function fetchEventos(): Promise<PtEvento[]> {
  const all: PtEvento[] = []
  let first = 0
  let total = Infinity

  for (let page = 0; page < MAX_PAGES && first < total; page++) {
    const tableParams = {
      first,
      rows: PAGE_SIZE,
      sortField: 'dataFim',
      sortOrder: 1,
      filters: { tipo: { value: REAL_ESTATE_TIPO_ID, matchMode: 'equals' } },
    }
    const url = `${PT_BASE}${LIST_PATH}?tableParams=${encodeURIComponent(JSON.stringify(tableParams))}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
      dispatcher: eLeiloesAgent,
    })
    if (!res.ok) throw new Error(`e-leiloes.pt Eventos fetch failed: ${res.status}`)

    const data = (await res.json()) as PtEventosResponse
    all.push(...data.list)
    total = data.pagination.total
    first += PAGE_SIZE
  }

  if (first < total) {
    throw new Error(
      `e-leiloes.pt Eventos: hit MAX_PAGES (${MAX_PAGES}) with ${total - all.length} records still unfetched`,
    )
  }

  return all
}

function buildAddress(evento: PtEvento, mapa: PtMapaItem | undefined): string | null {
  if (mapa?.morada) {
    const line = [mapa.morada, mapa.moradaNumero].filter(Boolean).join(' ')
    const cityLine = [mapa.moradaCP, mapa.moradaConcelho].filter(Boolean).join(' ')
    const andar = mapa.moradaAndar ? `, ${mapa.moradaAndar}` : ''
    return clean(`${line}${andar}, ${cityLine}, Portugal`)
  }
  const fallback = [evento.moradaFreguesia, evento.moradaConcelho, evento.moradaDistrito].filter(Boolean).join(', ')
  return fallback ? `${fallback}, Portugal` : null
}

function mapEvento(evento: PtEvento, mapa: PtMapaItem | undefined, platformId: string): Auction {
  const { iso: auctionDateIso, label: auctionDateText } = parsePtDateTime(evento.dataFim)
  const price = parsePtPrice(evento.valorBase)
  const detailUrl = `${PT_BASE}/evento/${evento.referencia}`
  const thumbnailUrl = evento.capa ? `${PT_BASE}/${evento.capa}` : null

  return {
    platform: platformId,
    country: COUNTRY,
    region: '',
    externalId: String(evento.id),
    caseNumber: evento.referencia,
    authority: '',
    title: clean(evento.titulo),
    address: buildAddress(evento, mapa),
    marketValueEur: price,
    marketValueText: formatPtPrice(price),
    auctionDateIso,
    auctionDateText,
    cancelled: evento.cancelado,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments: [],
    description: null,
    photoCount: thumbnailUrl ? 1 : 0,
    thumbnailUrl,
  }
}

export async function fetchAllListings(platformId: string): Promise<{ auctions: Auction[]; total: number | null }> {
  const [eventos, addressMap] = await Promise.all([fetchEventos(), fetchAddressMap()])
  const auctions = eventos.map((e) => mapEvento(e, addressMap.get(e.id), platformId))
  return { auctions, total: auctions.length }
}
