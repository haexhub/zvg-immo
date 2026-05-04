export type AttachmentKind = 'bekanntmachung' | 'foto' | 'exposee' | 'gutachten' | 'sonstiges'

export interface Attachment {
  kind: AttachmentKind
  label: string
  filename: string
  sizeBytes: number | null
  fileId: string
  /** Local proxy URL serving the file with the correct upstream Referer. */
  proxyUrl: string
}

export interface Auction {
  /** Which crawler produced this auction (matches PlatformCrawler.id). */
  platform: string
  zvgId: string
  aktenzeichen: string
  amtsgericht: string
  bundesland: string
  objekt: string | null
  adresse: string | null
  verkehrswertEur: number | null
  verkehrswertText: string | null
  terminIso: string | null
  terminText: string | null
  aufgehoben: boolean
  letzteAktualisierungIso: string | null
  /** Local proxy URL — direct upstream links require a zvg-portal.de Referer. */
  pdfUrl: string | null
  /** Local proxy URL for the upstream Detailansicht. */
  detailUrl: string
  /** Original upstream URL for the PDF (for reference). */
  pdfUrlUpstream: string | null
  /** Original upstream URL for the detail page (for reference). */
  detailUrlUpstream: string
  /** All attachments scraped from the Detailansicht page. */
  attachments: Attachment[]
  /** Free-text description scraped from the detail page (Beschreibung field). */
  beschreibung: string | null
  /** Number of photos available (counted from Foto attachments and embedded JPEGs). */
  fotoCount: number
  /** Local URL for a JPEG thumbnail of the first photo, if any. */
  thumbnailUrl: string | null
}

export interface CrawlResult {
  /** Platform id (matches PlatformCrawler.id). */
  platform: string
  source: string
  /** Bundesland(er) covered by this result. Empty array means "alle". */
  bundeslaender: string[]
  fetchedAt: string
  /** Total reported by the upstream platform; null when unknown or aggregated. */
  totalReported: number | null
  auctions: Auction[]
}
