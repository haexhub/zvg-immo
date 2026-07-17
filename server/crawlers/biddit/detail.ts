import type { Auction, Attachment } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { BIDDIT_BASE, UA } from './constants'
import { formatAddress, pickLocalized, type AddressLike, type LocalizedString } from './text'

interface DetailAttachment {
  attachmentId?: string | null
  name?: string | null
  bucketUrl?: string | null
  /** Biddit's enum-like classifier — values seen: SOIL_CERTIFICATE,
   *  PROPERTY_TAX, FLOOD_ZONE, URBANISM, ENERGY_PERFORMANCE_CERTIFICATE,
   *  CADASTRE, EXPERT_REPORT, … */
  type?: string | null
  size?: number | null
}

interface DetailPicture {
  pictureId?: string | null
  orderIndex?: number | null
  name?: string | null
  small?: string | null
  medium?: string | null
  large?: string | null
}

interface PropertyGeoLocation {
  lat?: number | null
  lng?: number | null
}

interface PropertyRooms {
  numberOfBedrooms?: number | null
  /** Wohnfläche in m² — lives under `rooms`, not `construction`. */
  livingSurfaceArea?: number | null
}

interface PropertyFeatures {
  /** Grundstücksfläche in m². */
  terrainSurface?: number | null
}

interface PropertyConstruction {
  constructionYear?: number | null
}

interface PropertyUtilities {
  /** EPC class as "CLASS_A" … "CLASS_F". */
  energeticClassRF?: string | null
  /** EPC score in kWh/m² per year. */
  pebScore?: number | null
}

interface PropertyFloodZone {
  floodZoneType?: string | null
}

interface PropertyDestination {
  isInvestmentProperty?: boolean | null
}

export interface DetailProperty {
  propertyId: string
  title?: LocalizedString | null
  description?: LocalizedString | null
  address?: AddressLike | null
  attachments?: DetailAttachment[] | null
  pictures?: DetailPicture[] | null
  attachmentZipBucketUrl?: string | null
  geoLocation?: PropertyGeoLocation | null
  rooms?: PropertyRooms | null
  features?: PropertyFeatures | null
  construction?: PropertyConstruction | null
  utilities?: PropertyUtilities | null
  floodZone?: PropertyFloodZone | null
  destination?: PropertyDestination | null
}

interface DetailTac {
  name?: string | null
  bucketUrl?: string | null
}

interface DetailResponse {
  lotId: string
  referenceCode: string
  estimatedPrice?: number | null
  startingPrice?: number | null
  biddingEndDateTime?: string | null
  publicSaleStatus?: string | null
  withdrawn?: boolean
  properties?: DetailProperty[] | null
  attachments?: DetailAttachment[] | null
  termsAndConditions?: DetailTac | null
}

export interface DetailInfo {
  /** The notary's appraisal when filled in — otherwise the Mindestgebot
   *  (startingPrice), which is the only real price biddit publishes. The
   *  fallback lives here (not in the consumer) because the geocode task's
   *  verkehrswert cache reads exactly this field. */
  estimatedPrice: number | null
  /** Raw Mindestgebot. `estimatedPrice === startingPrice` marks the price as
   *  the Mindestgebot fallback rather than an appraisal. */
  startingPrice: number | null
  beschreibung: string | null
  adresse: string | null
  attachments: Attachment[]
  fotoCount: number
  thumbnailUrl: string | null
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  aufgehoben: boolean
  lat: number | null
  lng: number | null
  sourceLivingAreaSqm: number | null
  sourceLandAreaSqm: number | null
}

const FETCH_TIMEOUT_MS = 20_000

function positive(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null
}

/** Display text for the price: estimatedPrice falls back to the Mindestgebot
 *  when biddit's appraisal holds its 1.00 placeholder — label that case so
 *  users don't read a starting bid as an appraised value. Single source for
 *  applyDetail and the geocode task's verkehrswert cache. */
export function formatVerkehrswertText(
  info: Pick<DetailInfo, 'estimatedPrice' | 'startingPrice'>,
): string | null {
  if (info.estimatedPrice == null) return null
  const formatted = `${info.estimatedPrice.toLocaleString('de-DE')} €`
  return info.estimatedPrice === info.startingPrice ? `ab ${formatted} (Mindestgebot)` : formatted
}

async function fetchDetailJson(referenceCode: string): Promise<DetailResponse | null> {
  const url = `${BIDDIT_BASE}/api/eco/biddit-bff/lot/${encodeURIComponent(referenceCode)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `${BIDDIT_BASE}/`,
      },
    })
    // 404/410 = lot vanished upstream — a permanent condition, reported as
    // null so callers don't retry it forever. Anything else non-ok is
    // transient (5xx, rate limit) and must surface as an error.
    if (res.status === 404 || res.status === 410) return null
    if (!res.ok) throw new Error(`biddit detail HTTP ${res.status}`)
    return (await res.json()) as DetailResponse
  } finally {
    clearTimeout(timer)
  }
}

/** Biddit's `type` is a stable enum (SOIL_CERTIFICATE, FLOOD_ZONE, etc.).
 *  Most of these are mandatory legal disclosures rather than the sale
 *  notice or appraisal, so the natural fallback is 'sonstiges'. The
 *  Cahier des charges / Verkoopsvoorwaarden (TAC) and any expert
 *  appraisal report are the two that map cleanly to existing kinds. */

function toAttachment(a: DetailAttachment): Attachment | null {
  if (!a.bucketUrl) return null
  const name = a.name ?? a.bucketUrl.split('/').pop() ?? 'document'
  return {
    kind: classifyAttachment(a.name, a.type),
    label: a.name ?? a.type ?? 'Document',
    filename: name,
    sizeBytes: typeof a.size === 'number' ? a.size : null,
    fileId: a.attachmentId ?? a.bucketUrl,
    proxyUrl: a.bucketUrl,
  }
}

function toPictureAttachment(p: DetailPicture): Attachment | null {
  const url = p.large ?? p.medium ?? p.small
  if (!url) return null
  return {
    kind: 'foto',
    label: p.name ?? 'Foto',
    filename: p.name ?? `${p.pictureId ?? 'photo'}.jpg`,
    sizeBytes: null,
    fileId: p.pictureId ?? url,
    proxyUrl: url,
  }
}

/** Renders the structured property facts that have no structured Auction
 *  field into a compact "Label: Wert" line appended to the description.
 *  Conservative: only unambiguous non-null values — flags and regional score
 *  codes (G-/P-score, buildingState enums) whose meaning needs context are
 *  left out. */
export function formatPropertyFacts(p: DetailProperty): string | null {
  const facts: string[] = []
  if (p.construction?.constructionYear != null) {
    facts.push(`Baujahr: ${p.construction.constructionYear}`)
  }
  // Biddit only publishes bedrooms (Schlafzimmer), which the extraction
  // pipeline deliberately distinguishes from a total room count — so this
  // stays text instead of feeding sourceRooms.
  if (p.rooms?.numberOfBedrooms != null) {
    facts.push(`Schlafzimmer: ${p.rooms.numberOfBedrooms}`)
  }
  const epcClass = p.utilities?.energeticClassRF?.replace(/^CLASS_/, '')
  if (epcClass) {
    const peb = p.utilities?.pebScore
    facts.push(
      peb != null
        ? `Energieklasse: ${epcClass} (${peb} kWh/m²·Jahr)`
        : `Energieklasse: ${epcClass}`,
    )
  }
  if (p.floodZone?.floodZoneType) {
    facts.push(`Überschwemmungsgebiet: ${p.floodZone.floodZoneType}`)
  }
  if (p.destination?.isInvestmentProperty) facts.push('Investmentobjekt')
  return facts.length > 0 ? facts.join(' · ') : null
}

export async function fetchDetail(referenceCode: string): Promise<DetailInfo | null> {
  const d = await fetchDetailJson(referenceCode)
  if (!d) return null
  const props = d.properties ?? []
  const prop = props[0] ?? null

  // Multi-property sales are rare but supported by the API: descriptions,
  // attachments and photos come from every property; address, structured
  // sizes and coordinates stay first-property-only (mixing several lots'
  // areas or pins would be meaningless).
  const descs = props
    .map((p) => pickLocalized(p.description) ?? pickLocalized(p.title))
    .filter((s): s is string => Boolean(s))
  const facts = prop ? formatPropertyFacts(prop) : null
  const beschreibung = [descs.join('\n\n'), facts].filter(Boolean).join('\n\n') || null
  const adresse = formatAddress(prop?.address)

  const attachments: Attachment[] = []
  for (const a of d.attachments ?? []) {
    const m = toAttachment(a)
    if (m) attachments.push(m)
  }
  for (const p of props) {
    for (const a of p.attachments ?? []) {
      const m = toAttachment(a)
      if (m) attachments.push(m)
    }
  }
  if (d.termsAndConditions?.bucketUrl) {
    attachments.push({
      kind: 'bekanntmachung',
      label: d.termsAndConditions.name ?? 'Cahier des charges',
      filename: d.termsAndConditions.name ?? 'cahier-des-charges.pdf',
      sizeBytes: null,
      // Synthesize a stable id — the TAC bucket URL embeds the saleId, so
      // it's stable across crawls without needing a dedicated identifier.
      fileId: `tac-${d.referenceCode}`,
      proxyUrl: d.termsAndConditions.bucketUrl,
    })
  }
  const photos: Attachment[] = []
  const seenPhotoIds = new Set<string>()
  for (const p of props) {
    for (const pic of p.pictures ?? []) {
      const m = toPictureAttachment(pic)
      if (m && !seenPhotoIds.has(m.fileId)) {
        seenPhotoIds.add(m.fileId)
        photos.push(m)
      }
    }
  }

  // Pictures appear in the listing JSON only as a single thumbnail per
  // property; the full set is detail-only. We sort by orderIndex so the
  // first one is consistently the "cover photo" the notary picked.
  const sortedPics = [...(prop?.pictures ?? [])].sort(
    (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
  )
  const firstPic = sortedPics[0]
  const thumbnailUrl = firstPic?.medium ?? firstPic?.small ?? firstPic?.large ?? null

  const tacPdf = attachments.find((a) => a.kind === 'bekanntmachung')
  const expertPdf = attachments.find((a) => a.kind === 'gutachten')
  const headlinePdf = tacPdf ?? expertPdf ?? attachments.find((a) => /\.pdf$/i.test(a.proxyUrl))

  // Biddit uses estimatedPrice = 1 as a "not filled in" placeholder (the field
  // is non-nullable in their DB). Real appraisals are always well above the
  // Mindestgebot, so anything ≤ 1 is treated as absent — in practice that is
  // nearly every lot, making the Mindestgebot the only price biddit actually
  // publishes. Fall back to it so the value reaches the map/list at all.
  const appraisal =
    d.estimatedPrice != null && d.estimatedPrice > 1 ? d.estimatedPrice : null
  const startingPrice =
    d.startingPrice != null && d.startingPrice > 1 ? d.startingPrice : null

  return {
    estimatedPrice: appraisal ?? startingPrice,
    startingPrice,
    beschreibung,
    adresse,
    attachments: [...attachments, ...photos],
    fotoCount: photos.length,
    thumbnailUrl,
    pdfUrl: headlinePdf?.proxyUrl ?? null,
    pdfUrlUpstream: headlinePdf?.proxyUrl ?? null,
    aufgehoben: Boolean(d.withdrawn) || d.publicSaleStatus === 'WITHDRAWN',
    // Biddit uses 0 as its "absent" sentinel on non-nullable DB fields (same
    // pattern as the estimatedPrice=1 placeholder) — treat non-positive as
    // null. That also guards the coordinates: 0/0 is the Atlantic, and all
    // real Belgian lat/lng values are positive.
    lat: positive(prop?.geoLocation?.lat),
    lng: positive(prop?.geoLocation?.lng),
    sourceLivingAreaSqm: positive(prop?.rooms?.livingSurfaceArea),
    sourceLandAreaSqm: positive(prop?.features?.terrainSurface),
  }
}

export async function enrichInBatches(
  auctions: Auction[],
  apply: (auction: Auction, info: DetailInfo) => void,
  concurrency = 8,
): Promise<{ enriched: number; errors: number }> {
  let cursor = 0
  let enriched = 0
  let errors = 0
  async function worker(): Promise<void> {
    while (cursor < auctions.length) {
      const idx = cursor++
      const item = auctions[idx]
      if (!item) continue
      try {
        const info = await fetchDetail(item.zvgId)
        if (info) {
          apply(item, info)
          enriched++
        } else {
          // Lot vanished upstream (404) — permanent, not an error.
          console.debug(`[biddit] lot ${item.zvgId} gone upstream — skipping enrichment`)
        }
      } catch (err) {
        console.debug(`[biddit] detail enrich failed for ${item.zvgId}: ${(err as Error).message}`)
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors }
}
