// G1 Roh-Archiv Schicht 2b: rohe Detail-Capture-Bytes archivieren
// (kind='detail_html'), analog zu archiveDocument (Schicht 2) aber für die
// Detailseite selbst statt für ein referenziertes Attachment.
//
// Fetching bleibt Sache des jeweiligen Crawlers — Rate-Limits, Captcha-
// Handling, Encoding und Session-Cookies unterscheiden sich stark zwischen
// Portalen (siehe boe/fetch.ts, hu/detail.ts). Dieses Modul archiviert nur,
// was der Crawler bereits geholt hat. `contentType` ist generisch über
// BlobContentType, nicht auf HTML festgelegt — ein künftiger Crawler, dessen
// "Detailseite" tatsächlich ein PDF/DOCX ist, nutzt dieselbe Funktion.
// `fetchTextAndArchive` ist ein Komfort-Wrapper für den Standardfall (kein
// Sonderfall-Fetch nötig).

import type { BlobContentType, DocumentIdentity } from './raw-archive'
import { archiveBlob, recordCapture } from './raw-archive'

/**
 * Archives raw detail-capture bytes (kind='detail_html'), keyed on
 * `(platform, externalId)`. Never throws — best-effort like archiveDocument.
 */
export async function archiveDetailCapture(
  bytes: Buffer,
  identity: DocumentIdentity,
  sourceUrl: string,
  capturedAt: string,
  contentType: BlobContentType = 'text/html',
): Promise<void> {
  const hash = await archiveBlob(bytes, contentType, identity.country)
  if (!hash) return
  await recordCapture({
    capturedAt,
    kind: 'detail_html',
    platform: identity.platform,
    country: identity.country,
    region: identity.region ?? null,
    externalId: identity.externalId,
    caseNumber: identity.caseNumber ?? null,
    authority: identity.authority ?? null,
    contentHash: hash,
    sourceUrl,
  })
}

/**
 * Fetches `url` as text and archives the raw bytes in one step — a drop-in
 * replacement for `(await fetch(url, init)).text()` in a crawler's detail
 * fetcher, for the common case where no custom fetch handling (rate limits,
 * captcha, cookies, non-UTF-8 encoding) is needed. Returns null on any fetch
 * failure (network error, non-2xx). Crawlers with such needs keep their own
 * fetch function and call `archiveDetailCapture` directly on the bytes it
 * returns.
 */
export async function fetchTextAndArchive(
  url: string,
  identity: DocumentIdentity,
  capturedAt: string,
  init?: RequestInit,
): Promise<string | null> {
  let buf: Buffer
  try {
    const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
  await archiveDetailCapture(buf, identity, url, capturedAt)
  return buf.toString('utf8')
}
