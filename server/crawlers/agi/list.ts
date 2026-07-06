import type { Auction } from '~/types/auction'
import { AGI_BASE, AGI_API_BASE, UA, ID_GENERE_IMMOBILI, DETAIL_BATCH_SIZE } from './constants'
import { cleanTipologia, pickTerminIso, formatEur, formatTerminText } from './text'

interface MapEntry {
  idLotto: number
  dataUltimoAggiornamento: string | null
}

interface Esito {
  ID: number
  Sigla: string | null
}

export interface DetailEntry {
  idLotto: number
  ruolo: string | null
  tribunale: string | null
  tipologia: string | null
  indirizzo: string | null
  comune: string | null
  provincia: string | null
  prezzoBase: number | null
  dataVendita: string | null
  dataFineGara: string | null
  dataUdienza: string | null
  descrizione: string | null
  urlPhoto: string | null
  urlSchedaDettagliata: string | null
  hasFoto: boolean
  esito: Esito
}

/** Establish a session and return a cookie string.
 *  The results page sets the ASP.NET Core session cookie required for API calls. */
export async function fetchSession(): Promise<string> {
  const res = await fetch(`${AGI_BASE}/results`, {
    headers: {
      'User-Agent': UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  const setCookieHeader = res.headers.getSetCookie?.() ?? []
  let cookie: string
  if (setCookieHeader.length === 0) {
    const raw = res.headers.get('set-cookie')
    cookie = raw ? (raw.split(';')[0] ?? '') : ''
  } else {
    cookie = setCookieHeader
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ')
  }
  if (!cookie) {
    throw new Error('[agi] fetchSession: no Set-Cookie header — session could not be established')
  }
  return cookie
}

/** Fetch all lot IDs + basic map data for the given portal region name. */
export async function fetchMapData(
  portalRegion: string,
  cookies: string,
): Promise<MapEntry[]> {
  const body = JSON.stringify({
    tipoRicerca: 1,
    regione: portalRegion,
    idGenere: ID_GENERE_IMMOBILI,
    storica: false,
    searchOnMap: false,
    idTipologie: [],
    idCategorie: [],
    orderBy: 6,
    noGeo: false,
  })
  const res = await fetch(`${AGI_API_BASE}/search/map`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Cookie: cookies,
      Origin: AGI_BASE,
      Referer: `${AGI_BASE}/results`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`[agi] search/map HTTP ${res.status}`)
  const data = (await res.json()) as MapEntry[]
  if (!Array.isArray(data)) throw new Error('[agi] search/map: unexpected response shape')
  return data
}

/** Fetch full detail for a batch of lot IDs. */
async function fetchDetailBatch(ids: number[], cookies: string): Promise<DetailEntry[]> {
  const res = await fetch(`${AGI_API_BASE}/search/Data`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Cookie: cookies,
      Origin: AGI_BASE,
      Referer: `${AGI_BASE}/results`,
    },
    body: JSON.stringify(ids),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`[agi] search/Data HTTP ${res.status}`)
  const data = (await res.json()) as DetailEntry[]
  if (!Array.isArray(data)) throw new Error('[agi] search/Data: unexpected response shape')
  return data
}

/** Fetch full detail for all lots in batches of DETAIL_BATCH_SIZE. */
export async function fetchAllDetails(
  ids: number[],
  cookies: string,
): Promise<DetailEntry[]> {
  const results: DetailEntry[] = []
  for (let i = 0; i < ids.length; i += DETAIL_BATCH_SIZE) {
    const batch = ids.slice(i, i + DETAIL_BATCH_SIZE)
    try {
      const entries = await fetchDetailBatch(batch, cookies)
      results.push(...entries)
    } catch (err) {
      console.warn(`[agi] fetchAllDetails: batch ${i}–${i + batch.length - 1} failed, skipping: ${(err as Error).message}`)
    }
  }
  return results
}

/** Italian CAP: exactly 5 digits — when present the indirizzo already contains the city. */
const CAP_RE = /\b\d{5}\b/

function buildAdresse(
  indirizzo: string | null,
  comune: string | null,
  provincia: string | null,
): string | null {
  if (!indirizzo && !comune) return null
  if (!indirizzo) return provincia ? `${comune} (${provincia})` : comune
  // If indirizzo already contains a CAP or the city name, it is already complete.
  if (CAP_RE.test(indirizzo)) return indirizzo
  if (comune && indirizzo.toLowerCase().includes(comune.toLowerCase())) return indirizzo
  // Append city and province for geocodability.
  const suffix = comune
    ? provincia
      ? `${comune} (${provincia})`
      : comune
    : provincia
      ? `(${provincia})`
      : null
  return suffix ? `${indirizzo}, ${suffix}` : indirizzo
}

/** esito.ID that marks a lot as a still-pending, live auction; every other
 *  esito is a concluded/cancelled outcome and is flagged aufgehoben (hidden
 *  from the default active view). A missing esito is treated as active.
 *
 *  Verified against ~4200 live lots on 2026-07-06 (search/Data esito.ID →
 *  Descrizione), so the mapping is data-backed rather than guessed:
 *    0  Sconosciuto      → active (shown)          — 77% of active lots
 *    1  Aggiudicata      → aufgehoben (sold)
 *    2  Non Aggiudicata  → aufgehoben (not awarded)
 *    3  Rinviata         → aufgehoben (postponed)
 *    4  Sospesa          → aufgehoben (suspended)
 *    5  Estinta          → aufgehoben (extinguished)
 *    8  Deserta          → aufgehoben (no bids)
 *    10 Revocata         → aufgehoben (revoked; note Sigla is null here)
 *  Sigla is NOT unique per outcome (NAGG covers 2/3/8, OFF covers 4/5) and is
 *  null for Revocata, so we key on the numeric ID. Any unknown/new ID falls
 *  through to aufgehoben — conservative for an "active auctions" listing. */
const ACTIVE_ESITO_ID = 0

/** Build Auction objects by merging map data (lat/lng) with detail data. */
export function buildAuctions(
  mapEntries: MapEntry[],
  details: DetailEntry[],
  regionName: string,
  platform: string,
): Auction[] {
  const mapByLot = new Map<number, MapEntry>(mapEntries.map((e) => [e.idLotto, e]))

  return details.map((d): Auction => {
    const map = mapByLot.get(d.idLotto)
    const terminIso = pickTerminIso(d.dataVendita, d.dataFineGara, d.dataUdienza)
    const verkehrswertEur = d.prezzoBase ?? null
    const thumbnailUrl = d.urlPhoto ? `${AGI_BASE}${d.urlPhoto}` : null
    const detailUpstream = d.urlSchedaDettagliata ? `${AGI_BASE}${d.urlSchedaDettagliata}` : null
    const adresse = buildAdresse(d.indirizzo, d.comune, d.provincia)

    return {
      platform,
      country: 'it',
      region: regionName,
      zvgId: String(d.idLotto),
      aktenzeichen: d.ruolo ?? '',
      amtsgericht: d.tribunale ?? '',
      objekt: cleanTipologia(d.tipologia),
      adresse,
      verkehrswertEur,
      verkehrswertText: formatEur(verkehrswertEur),
      terminIso,
      terminText: formatTerminText(terminIso),
      aufgehoben: d.esito != null && d.esito.ID !== ACTIVE_ESITO_ID,
      letzteAktualisierungIso: map?.dataUltimoAggiornamento ?? null,
      pdfUrl: null,
      detailUrl: detailUpstream,
      pdfUrlUpstream: null,
      detailUrlUpstream: detailUpstream,
      attachments: [],
      beschreibung: d.descrizione ?? null,
      fotoCount: d.hasFoto ? 1 : 0,
      thumbnailUrl,
    }
  })
}
