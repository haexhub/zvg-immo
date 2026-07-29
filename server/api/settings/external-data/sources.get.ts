// Lists every configurable external-data source (sources.ts's configFields)
// with its current DB override, env-resolved effective value and whether
// it's usable as-is — one generic route for every source instead of a
// bespoke endpoint per adapter. Admin-only via /api/settings/'s
// settings-auth guard.

import { getPool } from '~/server/utils/db'
import {
  configurableExternalDataSources,
  getAllStoredExternalDataSourceConfigs,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'

export default defineEventHandler(async () => {
  const db = getPool()
  const stored = db ? await getAllStoredExternalDataSourceConfigs(db) : {}
  const runtimeConfig = (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}

  return {
    sources: configurableExternalDataSources().map((source) => {
      const sourceStored = stored[source.id] ?? {}
      const resolved = resolveExternalDataSourceConfig(source, sourceStored, runtimeConfig)
      return {
        id: source.id,
        label: source.label,
        sourceUrl: source.sourceUrl,
        licenseNote: source.licenseNote,
        refreshCadence: source.refreshCadence,
        isConfigured: resolved.isConfigured,
        fields: (source.configFields ?? []).map((field) => ({
          key: field.key,
          type: field.type,
          envVar: field.envVar,
          required: field.required === true,
          storedValue: sourceStored[field.key] ?? null,
          effectiveValue: resolved.values[field.key],
        })),
      }
    }),
  }
})
