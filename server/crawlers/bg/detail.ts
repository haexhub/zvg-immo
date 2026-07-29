import type { Attachment, Auction } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { BG_API_BASE, UA } from './constants'

interface BgAttachmentBlob {
  fileType: string | null
  href: string | null
}

interface BgAttachment {
  id: number
  fileName: string | null
  blob: BgAttachmentBlob | null
}

interface BgItem {
  identifier: string | null
}

interface BgDetail {
  items: BgItem[] | null
  attachments: BgAttachment[] | null
}

const IMAGE_EXT_RE = /^(jpe?g|png|webp)$/i

export async function enrichOne(auction: Auction): Promise<void> {
  const url = `${BG_API_BASE}/announcements/${auction.externalId}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`zapori.mjs.bg detail ${auction.externalId}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await archiveDetailCapture(
    bytes,
    {
      platform: auction.platform,
      country: auction.country,
      region: auction.region,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber,
      authority: auction.authority,
    } satisfies DocumentIdentity,
    url,
    new Date().toISOString(),
    'application/json',
  )

  const d = JSON.parse(bytes.toString('utf8')) as BgDetail

  const photoUrls: string[] = []
  const attachments: Attachment[] = []
  for (const att of d.attachments ?? []) {
    const href = att.blob?.href
    if (!href) continue
    const ext = (att.blob?.fileType ?? '').replace(/^\./, '')
    if (IMAGE_EXT_RE.test(ext)) {
      photoUrls.push(href)
    } else {
      attachments.push({
        kind: 'announcement',
        label: att.fileName ?? 'Обявление',
        filename: att.fileName ?? `attachment-${att.id}`,
        sizeBytes: null,
        fileId: String(att.id),
        proxyUrl: href,
      })
    }
  }

  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = photoUrls[0] ?? null
  }
  if (attachments.length > 0) auction.attachments = attachments

  // Cadastral identifiers are only ever in the detail response's `items`,
  // never in the list/description text — appended once, not on every rerun.
  const identifiers = (d.items ?? [])
    .map((item) => item.identifier)
    .filter((id): id is string => Boolean(id))
  if (identifiers.length > 0) {
    const line = `Идентификатор: ${identifiers.join(', ')}`
    if (!auction.description?.includes(line)) {
      auction.description = [auction.description, line].filter(Boolean).join('\n\n')
    }
  }
}
