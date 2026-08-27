// Durable daily readings of the same aggregates shown by SettingsCountryStatusOverview.
// A snapshot is an upsert: an operator can safely re-run the task after a
// deployment without getting multiple incomparable readings for one day.

import { readAuctionRecords } from './auction-record'
import { readCrawlStatusByCountry } from './crawl-status'
import { getPool } from './db'
import { classifyLlmStatus, isLlmExtractionInScope } from './llm-status'
import { readOsmStatusByCountry } from './osm-status'
import { readTranslationStatusByCountryAndLanguage } from './translation-status'

export type DailySnapshotKind = 'crawl' | 'llm' | 'translation' | 'osm'

export interface DailyStatusSnapshot {
  snapshotDate: string
  country: string
  kind: DailySnapshotKind
  targetLang: string | null
  done: number
  pending: number
  open: number
  error: number
  total: number
  capturedAt: string
}

type Counts = Pick<DailyStatusSnapshot, 'done' | 'pending' | 'open' | 'error' | 'total'>
const EMPTY_COUNTS: Counts = { done: 0, pending: 0, open: 0, error: 0, total: 0 }

function berlinDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((value) => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function llmCounts(records: Awaited<ReturnType<typeof readAuctionRecords>>): Record<string, Counts> {
  const out: Record<string, Counts> = {}
  for (const record of records) {
    if (!isLlmExtractionInScope(record)) continue
    const counts = out[record.auction.country] ?? (out[record.auction.country] = { ...EMPTY_COUNTS })
    counts[classifyLlmStatus(record)]++
    counts.total++
  }
  return out
}

/** Stores a complete per-country dashboard reading for the Berlin calendar day. */
export async function captureDailyStatusSnapshot(snapshotDate = berlinDay()): Promise<number> {
  const db = getPool()
  if (!db) return 0
  const [crawl, records, translations, osm] = await Promise.all([
    readCrawlStatusByCountry(),
    readAuctionRecords(undefined, { includePhotos: false }),
    readTranslationStatusByCountryAndLanguage(),
    readOsmStatusByCountry(),
  ])
  const llm = llmCounts(records)
  const countries = new Set([...Object.keys(crawl), ...Object.keys(llm), ...Object.keys(translations), ...osm.map((row) => row.code)])
  let saved = 0
  for (const country of countries) {
    const rows: Array<{ kind: DailySnapshotKind; targetLang: string; counts: Counts }> = [
      { kind: 'crawl', targetLang: '', counts: crawl[country] ?? { ...EMPTY_COUNTS } },
      { kind: 'llm', targetLang: '', counts: llm[country] ?? { ...EMPTY_COUNTS } },
    ]
    for (const [targetLang, counts] of Object.entries(translations[country] ?? {})) {
      if (counts) rows.push({ kind: 'translation', targetLang, counts })
    }
    const osmCounts = osm.find((row) => row.code === country)
    if (osmCounts) rows.push({
      kind: 'osm', targetLang: '',
      counts: { done: osmCounts.attachedAuctions, pending: 0, open: osmCounts.openAuctions,
        error: osmCounts.errorAuctions, total: osmCounts.auctionTotal },
    })
    for (const row of rows) {
      await db.query(
        `INSERT INTO status_daily_snapshots
          (snapshot_date, country, kind, target_lang, done, pending, open, error, total, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (snapshot_date, country, kind, target_lang) DO UPDATE SET
           done = EXCLUDED.done, pending = EXCLUDED.pending, open = EXCLUDED.open,
           error = EXCLUDED.error, total = EXCLUDED.total, captured_at = EXCLUDED.captured_at`,
        [snapshotDate, country, row.kind, row.targetLang, row.counts.done, row.counts.pending,
          row.counts.open, row.counts.error, row.counts.total],
      )
      saved++
    }
  }
  return saved
}

export async function readDailyStatusSnapshots(days = 14): Promise<DailyStatusSnapshot[]> {
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<{
    snapshot_date: Date | string; country: string; kind: DailySnapshotKind; target_lang: string
    done: number; pending: number; open: number; error: number; total: number; captured_at: Date | string
  }>(
    `SELECT snapshot_date, country, kind, target_lang, done, pending, open, error, total, captured_at
       FROM status_daily_snapshots
      WHERE snapshot_date >= (CURRENT_DATE - ($1::integer - 1))
      ORDER BY snapshot_date DESC, country ASC, kind ASC, target_lang ASC`,
    [days],
  )
  return rows.map((row) => ({
    // node-postgres parses `date` columns into a JS Date (UTC midnight), not the
    // 'YYYY-MM-DD' string the type below promises — left as a Date, JSON
    // serializes it to a full ISO timestamp, and the frontend's `${day}T12:00:00Z`
    // parsing then throws RangeError: Invalid time value on the doubled suffix.
    snapshotDate: row.snapshot_date instanceof Date ? row.snapshot_date.toISOString().slice(0, 10) : row.snapshot_date,
    country: row.country,
    kind: row.kind,
    targetLang: row.target_lang || null,
    done: row.done, pending: row.pending, open: row.open, error: row.error, total: row.total,
    capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : row.captured_at,
  }))
}
