import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  try {
    if (country === 'all') {
      // All countries, all regions. Detail enrichment off — a country-wide
      // crawl across every platform would otherwise issue thousands of
      // detail fetches and time out behind Traefik.
      return await crawlAll({ immobilienOnly, enrichDetails: false })
    }
    if (region === 'all') {
      // One country, all its regions. Same reasoning as above.
      return await crawlAll({ immobilienOnly, country, enrichDetails: false })
    }
    return await crawlSingle({ country, region, immobilienOnly })
  } catch (err) {
    // Normalize: thrown values aren't guaranteed to be Errors.
    const msg =
      typeof err === 'string'
        ? err
        : err instanceof Error
          ? err.message
          : String(err)
    // Upstream rate-limit responses (BOE's captcha page or an HTTP 429) are
    // temporary and self-clear within minutes. Surfacing them as 502 makes
    // the whole map view break for that provincia, including the geocoding
    // data we already have. Degrade gracefully: log server-side, return an
    // empty result so the rest of the UI keeps working.
    const lower = msg.toLowerCase()
    const rateLimited =
      lower.includes('captcha') || lower.includes('rate limit') || /\b429\b/.test(msg)
    if (rateLimited) {
      console.warn(`[api/auctions] ${country}/${region} rate-limited: ${msg}`)
      return {
        platform: 'multi',
        source: '',
        countries: [country],
        regions: [region],
        fetchedAt: new Date().toISOString(),
        totalReported: null,
        auctions: [],
      }
    }
    throw createError({
      statusCode: 502,
      statusMessage: 'Crawler-Quelle nicht erreichbar',
      data: { detail: msg },
    })
  }
})
