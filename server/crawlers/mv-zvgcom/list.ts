import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { ZVGCOM_BASE, UA, COUNTRY, ZVGCOM_STATES, AUFGEHOBEN_PLACEHOLDER_IMG } from './constants'
import { parseMvDateTime, stripAzPrefix } from './text'

interface GerichtInfo {
  plz: string
  ort: string
  bundesland: string
  url: string
}

interface ListItem {
  id: number
  img: string
  az: string
  terminAufgehoben: number
  active: number
  title: string
  street: string
  plz: string
  city: string
  vwert: number
  date: string
  time: string
  ag: string
  /** "16.07.2026" — when the listing was added/last touched on zvg.com. */
  dateAdded: string
  gutachten: string
  gericht: GerichtInfo
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ZVGCOM_BASE}${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`zvg.com ${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function mapItem(item: ListItem, platformId: string, region: string): Auction {
  const { iso: auctionDateIso, label: auctionDateText } = parseMvDateTime(item.date, item.time)
  const title = stripAzPrefix(item.title, item.az) || null
  const address = [item.street, [item.plz, item.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ') || null

  const isPlaceholderImg = item.img === AUFGEHOBEN_PLACEHOLDER_IMG
  const thumbnailUrl = item.img && !isPlaceholderImg ? `${ZVGCOM_BASE}${item.img}` : null

  const attachments: Attachment[] = []
  if (item.gutachten) {
    const filename = item.gutachten.split('/').pop() || 'Gutachten.pdf'
    attachments.push({
      kind: classifyAttachment('Gutachten', filename),
      label: 'Gutachten',
      filename,
      sizeBytes: null,
      fileId: item.gutachten,
      proxyUrl: `${ZVGCOM_BASE}${item.gutachten}`,
    })
  }

  const detailUrl = `${ZVGCOM_BASE}/objekt/${item.id}/show`

  return {
    platform: platformId,
    country: COUNTRY,
    region,
    externalId: String(item.id),
    caseNumber: item.az,
    authority: item.ag,
    title,
    address,
    marketValueEur: item.vwert > 0 ? item.vwert : null,
    marketValueText: item.vwert > 0 ? `${item.vwert.toLocaleString('de-DE')} €` : null,
    auctionDateIso,
    auctionDateText,
    cancelled: item.terminAufgehoben === 1,
    sourceUpdatedIso: parseMvDateTime(item.dateAdded, null).iso,
    pdfUrl: attachments[0]?.proxyUrl ?? null,
    detailUrl,
    pdfUrlUpstream: attachments[0]?.proxyUrl ?? null,
    detailUrlUpstream: detailUrl,
    attachments,
    description: null,
    photoCount: thumbnailUrl ? 1 : 0,
    thumbnailUrl,
  }
}

async function fetchStateListings(
  state: (typeof ZVGCOM_STATES)[number],
  platformId: string,
): Promise<Auction[]> {
  const items = await fetchJson<ListItem[]>(
    `/v2024/termine.prg?act=getGridJson&id_b=${state.bundeslandId}`,
  )
  return items
    .filter((i) => i.active === 1)
    .map((item) => mapItem(item, platformId, state.name))
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const perState = await Promise.all(
    ZVGCOM_STATES.map((state) => fetchStateListings(state, platformId)),
  )
  const auctions = perState.flat()
  return { auctions, total: auctions.length }
}
