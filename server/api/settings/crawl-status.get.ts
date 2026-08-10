import { readCrawlStatusByCountry, type CrawlStatusCounts } from '~/server/utils/crawl-status'

export default defineEventHandler(async (): Promise<Record<string, CrawlStatusCounts>> => {
  return readCrawlStatusByCountry()
})
