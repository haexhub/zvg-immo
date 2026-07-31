// Postgres-backed cache for translated/transliterated OSM place names
// (place_name_translations table). Keyed by (name, lang) only — not per
// auction — since the same settlement/industrial site/airport name is
// referenced by every nearby auction. Immutable once written, like
// content_translations: a concurrent duplicate insert for the same brand-new
// name is a harmless no-op.

import type { Pool } from 'pg'

export async function readPlaceNameTranslations(
  db: Pool,
  names: readonly string[],
  lang: string,
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map()
  const { rows } = await db.query<{ name: string; translated: string }>(
    `SELECT name, translated FROM place_name_translations WHERE name = ANY($1) AND lang = $2`,
    [names, lang],
  )
  return new Map(rows.map((row) => [row.name, row.translated]))
}

export async function writePlaceNameTranslations(
  db: Pool,
  lang: string,
  entries: readonly { name: string; translated: string }[],
): Promise<void> {
  if (entries.length === 0) return
  const values: string[] = []
  const params: string[] = []
  entries.forEach((entry, i) => {
    const base = i * 3
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`)
    params.push(entry.name, lang, entry.translated)
  })
  await db.query(
    `INSERT INTO place_name_translations (name, lang, translated)
     VALUES ${values.join(', ')}
     ON CONFLICT (name, lang) DO NOTHING`,
    params,
  )
}
