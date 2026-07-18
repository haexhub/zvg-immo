// Per-lot detail fetcher used by the map popover to lazy-load photos. The
// multi-region /api/auctions crawl uses enrichDetails: false to keep the
// Europa view fast; this endpoint fills the photo gap on demand when the
// user opens a marker popover.

import type { Attachment } from '~/types/auction'
import { fetchDetail as fetchAtDetail } from '../crawlers/at/detail'
import { fetchDetail as fetchBidditDetail } from '../crawlers/biddit/detail'
import { fetchDetailPage as fetchZvgDetail } from '../crawlers/zvg-portal/detail'
import { AT_BASE } from '../crawlers/at/constants'
import { DE_REGIONS } from '../crawlers/zvg-portal/constants'

export interface AuctionPhotoDetail {
  attachments: Attachment[]
  thumbnailUrl: string | null
  photoCount: number
}

function landAbkFromRegionName(regionName: string): string | null {
  const hit = DE_REGIONS.find((r) => r.name === regionName)
  return hit?.code ?? null
}

export default defineEventHandler(async (event): Promise<AuctionPhotoDetail> => {
  const query = getQuery(event)
  const platform = String(query.platform ?? '')
  const externalId = String(query.externalId ?? '')
  const region = typeof query.region === 'string' ? query.region : ''

  // Shape check: externalId is interpolated into upstream URLs (AT path segment,
  // zvg-portal query string), so reject anything that could smuggle extra
  // path segments or query parameters. Covers all platforms: zvg-portal ids
  // are numeric, AT ids are Notes UNIDs (hex), Biddit ids are alphanumeric.
  if (!platform || !/^[\w-]{1,64}$/.test(externalId)) {
    throw createError({ statusCode: 400, statusMessage: 'platform and externalId required' })
  }

  const empty: AuctionPhotoDetail = { attachments: [], thumbnailUrl: null, photoCount: 0 }

  try {
    switch (platform) {
      case 'at-edikte': {
        const detailUrl = `${AT_BASE}/edikte/ex/exedi3.nsf/alldoc/${externalId}!OpenDocument`
        const info = await fetchAtDetail(detailUrl)
        return {
          attachments: info.attachments,
          thumbnailUrl: info.thumbnailUrl,
          photoCount: info.photoCount,
        }
      }
      case 'biddit': {
        const info = await fetchBidditDetail(externalId)
        if (!info) return empty
        return {
          attachments: info.attachments,
          thumbnailUrl: info.thumbnailUrl,
          photoCount: info.photoCount,
        }
      }
      case 'zvg-portal': {
        const landAbk = landAbkFromRegionName(region)
        if (!landAbk) return empty
        const info = await fetchZvgDetail(externalId, landAbk)
        const fotos = info.attachments.filter((a) => a.kind === 'photo')
        const firstFoto = fotos[0]
        return {
          attachments: info.attachments,
          thumbnailUrl: firstFoto
            ? `/api/zvg-thumb?file_id=${firstFoto.fileId}&zvg_id=${externalId}&land_abk=${landAbk}`
            : null,
          photoCount: fotos.length,
        }
      }
      default:
        return empty
    }
  } catch (err) {
    console.warn(`[auction-detail] ${platform}/${externalId}: ${(err as Error).message}`)
    return empty
  }
})
