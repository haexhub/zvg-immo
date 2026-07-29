// Generic admin-configurable settings for external-data sources (sources.ts's
// configFields) — one app_settings row per source, resolved as DB override >
// env-configured runtimeConfig.externalData.* > the field's own default. This
// is the single path every configurable source goes through; adding a new
// source's configFields to sources.ts is enough to make it show up in
// /settings and get picked up by server/tasks/external-enrichment.ts, without
// touching the API route or the settings card.

import type { Pool } from 'pg'
import {
  EXTERNAL_DATA_SOURCES,
  type ExternalDataConfigField,
  type ExternalDataSource,
} from './sources'

export type ExternalDataSourceConfigValues = Record<string, string | number>

export function configurableExternalDataSources(): ExternalDataSource[] {
  return EXTERNAL_DATA_SOURCES.filter((source) => (source.configFields?.length ?? 0) > 0)
}

export function getConfigurableExternalDataSource(sourceId: string): ExternalDataSource | undefined {
  return configurableExternalDataSources().find((source) => source.id === sourceId)
}

function settingsKey(sourceId: string): string {
  return `external_data_config_${sourceId}`
}

// undefined = "not set here" — the caller falls back to env/default. Distinct
// from '' (a field can't be explicitly overridden to an empty string; that's
// indistinguishable from clearing the override, which is the desired UX).
function coerceFieldValue(raw: unknown, field: ExternalDataConfigField): string | number | undefined {
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed || undefined
}

/** DB-stored overrides only, no env/default merge — mirrors
 *  getLlmProviderOverride()'s "null means nothing stored" contract. */
export async function getStoredExternalDataSourceConfig(
  db: Pool,
  sourceId: string,
): Promise<ExternalDataSourceConfigValues> {
  const source = getConfigurableExternalDataSource(sourceId)
  if (!source) return {}
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [settingsKey(sourceId)],
  )
  const stored = (rows[0]?.value ?? {}) as Record<string, unknown>
  const values: ExternalDataSourceConfigValues = {}
  for (const field of source.configFields ?? []) {
    const value = coerceFieldValue(stored[field.key], field)
    if (value !== undefined) values[field.key] = value
  }
  return values
}

export async function getAllStoredExternalDataSourceConfigs(
  db: Pool,
): Promise<Record<string, ExternalDataSourceConfigValues>> {
  const sources = configurableExternalDataSources()
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1)',
    [sources.map((source) => settingsKey(source.id))],
  )
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  const result: Record<string, ExternalDataSourceConfigValues> = {}
  for (const source of sources) {
    const stored = (byKey.get(settingsKey(source.id)) ?? {}) as Record<string, unknown>
    const values: ExternalDataSourceConfigValues = {}
    for (const field of source.configFields ?? []) {
      const value = coerceFieldValue(stored[field.key], field)
      if (value !== undefined) values[field.key] = value
    }
    result[source.id] = values
  }
  return result
}

export async function setStoredExternalDataSourceConfig(
  db: Pool,
  sourceId: string,
  rawValues: Record<string, unknown>,
): Promise<ExternalDataSourceConfigValues> {
  const source = getConfigurableExternalDataSource(sourceId)
  if (!source) throw new Error(`unknown external-data source: ${sourceId}`)
  const values: ExternalDataSourceConfigValues = {}
  for (const field of source.configFields ?? []) {
    const value = coerceFieldValue(rawValues[field.key], field)
    if (value !== undefined) values[field.key] = value
  }
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [settingsKey(sourceId), JSON.stringify(values)],
  )
  return values
}

interface ExternalDataRuntimeConfigLike {
  [key: string]: string | number | undefined
}

function resolveFieldValue(
  field: ExternalDataConfigField,
  stored: ExternalDataSourceConfigValues,
  runtimeConfig: ExternalDataRuntimeConfigLike,
): string | number {
  const storedValue = stored[field.key]
  if (storedValue !== undefined) return storedValue
  const envValue = coerceFieldValue(runtimeConfig[field.runtimeConfigKey], field)
  if (envValue !== undefined) return envValue
  return field.defaultValue
}

export interface ResolvedExternalDataSourceConfig {
  values: ExternalDataSourceConfigValues
  /** False when a required field has no value from DB, env, or default —
   *  server/tasks/external-enrichment.ts skips building this source's
   *  adapter entirely, same graceful-degrade contract nuxt.config.ts
   *  documents today for empty externalData.* values. */
  isConfigured: boolean
}

export function resolveExternalDataSourceConfig(
  source: ExternalDataSource,
  stored: ExternalDataSourceConfigValues,
  runtimeConfig: ExternalDataRuntimeConfigLike,
): ResolvedExternalDataSourceConfig {
  const values: ExternalDataSourceConfigValues = {}
  let isConfigured = true
  for (const field of source.configFields ?? []) {
    const value = resolveFieldValue(field, stored, runtimeConfig)
    values[field.key] = value
    if (field.required && value === '') isConfigured = false
  }
  return { values, isConfigured }
}
