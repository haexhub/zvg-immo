import type { Auction, Attachment, AttachmentKind } from '~/types/auction'
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

interface DetailProperty {
  propertyId: string
  title?: LocalizedString | null
  description?: LocalizedString | null
  address?: AddressLike | null
  attachments?: DetailAttachment[] | null
  pictures?: DetailPicture[] | null
  attachmentZipBucketUrl?: string | null
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
  estimatedPrice: number | null
  beschreibung: string | null
  adresse: string | null
  attachments: Attachment[]
  fotoCount: number
  thumbnailUrl: string | null
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  aufgehoben: boolean
}

const FETCH_TIMEOUT_MS = 20_000

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
function classify(name: string | null | undefined, docType: string | null | undefined): AttachmentKind {
  const haystack = `${name ?? ''} ${docType ?? ''}`.toLowerCase()
  if (/tac|cahier|terms|conditions|verkoopsvoorwaarden/.test(haystack)) return 'bekanntmachung'
  if (/expert|expertise|estim|sch[aä]tz|gutacht/.test(haystack)) return 'gutachten'
  if (/expos|brochure|prospect/.test(haystack)) return 'exposee'
  if (/photo|picture|foto|image/.test(haystack)) return 'foto'
  return 'sonstiges'
}

function toAttachment(a: DetailAttachment): Attachment | null {
  if (!a.bucketUrl) return null
  const name = a.name ?? a.bucketUrl.split('/').pop() ?? 'document'
  return {
    kind: classify(a.name, a.type),
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

export async function fetchDetail(referenceCode: string): Promise<DetailInfo | null> {
  const d = await fetchDetailJson(referenceCode)
  if (!d) return null
  const prop = d.properties?.[0] ?? null

  const beschreibung = pickLocalized(prop?.description) ?? pickLocalized(prop?.title) ?? null
  const adresse = formatAddress(prop?.address)

  const attachments: Attachment[] = []
  for (const a of d.attachments ?? []) {
    const m = toAttachment(a)
    if (m) attachments.push(m)
  }
  for (const a of prop?.attachments ?? []) {
    const m = toAttachment(a)
    if (m) attachments.push(m)
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
  for (const p of prop?.pictures ?? []) {
    const m = toPictureAttachment(p)
    if (m) photos.push(m)
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
  // Mindestgebot, so anything ≤ 1 is treated as absent.
  const estimatedPrice =
    d.estimatedPrice != null && d.estimatedPrice > 1 ? d.estimatedPrice : null

  return {
    estimatedPrice,
    beschreibung,
    adresse,
    attachments: [...attachments, ...photos],
    fotoCount: photos.length,
    thumbnailUrl,
    pdfUrl: headlinePdf?.proxyUrl ?? null,
    pdfUrlUpstream: headlinePdf?.proxyUrl ?? null,
    aufgehoben: Boolean(d.withdrawn) || d.publicSaleStatus === 'WITHDRAWN',
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
