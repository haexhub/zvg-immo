import type { Auction } from '~/types/auction'

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, raw: string) => {
      const code = Number.parseInt(raw, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, raw: string) => {
      const code = Number.parseInt(raw, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

function stripExecutableHtml(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '')
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

function stripHydrationState(text: string): string {
  return text
    .replace(/(?:window\.)?AppRegistry\.[^\n\r]*/g, '')
    .replace(/(?:__NUXT__|__NEXT_DATA__|webpackJsonp|webpackChunk)[^\n\r]*/g, '')
    .replace(/\b(?:registerBootstrapData|registerInitialState|registerApp)\([^ \n\r]{80,}[^\n\r]*/g, '')
}

function punctuationDensity(line: string): number {
  if (!line) return 0
  const technical = line.match(/[{}()[\]=:;"'`,;|\\]/g)?.length ?? 0
  return technical / line.length
}

function isTechnicalJunkLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/\b(?:AppRegistry|applicationId|portletId|webAppVersion|requiredLibs|AGNOSTIC_RENDERER)\b/.test(trimmed)) return true
  const longestToken = Math.max(...trimmed.split(/\s+/).map((token) => token.length))
  if (trimmed.length > 500 && punctuationDensity(trimmed) > 0.08) return true
  return longestToken > 240 && punctuationDensity(trimmed) > 0.05
}

export function normalizeDescriptionText(input: string | null | undefined): string | null {
  if (!input) return null
  const lines = stripHydrationState(stripHtml(stripExecutableHtml(decodeEntities(input))))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => !isTechnicalJunkLine(line))

  const out: string[] = []
  for (const line of lines) {
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    out.push(line)
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || null
}

export function normalizeAuctionDescription(auction: Auction): void {
  auction.description = normalizeDescriptionText(auction.description)
}

export function normalizeAuctionDescriptions(auctions: Auction[]): void {
  for (const auction of auctions) normalizeAuctionDescription(auction)
}
