import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { ZVGCOM_BASE, UA, COUNTRY, MV_BUNDESLAND_ID, AUFGEHOBEN_PLACEHOLDER_IMG } from './constants'
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

function mapItem(item: ListItem, platformId: string): Auction {
  const { iso: terminIso, label: terminText } = parseMvDateTime(item.date, item.time)
  const objekt = stripAzPrefix(item.title, item.az) || null
  const adresse = [item.street, [item.plz, item.city].filter(Boolean).join(' ')]
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
    region: 'Mecklenburg-Vorpommern',
    zvgId: String(item.id),
    aktenzeichen: item.az,
    amtsgericht: item.ag,
    objekt,
    adresse,
    verkehrswertEur: item.vwert > 0 ? item.vwert : null,
    verkehrswertText: item.vwert > 0 ? `${item.vwert.toLocaleString('de-DE')} €` : null,
    terminIso,
    terminText,
    aufgehoben: item.terminAufgehoben === 1,
    letzteAktualisierungIso: parseMvDateTime(item.dateAdded, null).iso,
    pdfUrl: attachments[0]?.proxyUrl ?? null,
    detailUrl,
    pdfUrlUpstream: attachments[0]?.proxyUrl ?? null,
    detailUrlUpstream: detailUrl,
    attachments,
    beschreibung: null,
    fotoCount: thumbnailUrl ? 1 : 0,
    thumbnailUrl,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const items = await fetchJson<ListItem[]>(
    `/v2024/termine.prg?act=getGridJson&id_b=${MV_BUNDESLAND_ID}`,
  )
  const auctions = items.filter((i) => i.active === 1).map((item) => mapItem(item, platformId))
  return { auctions, total: auctions.length }
}
