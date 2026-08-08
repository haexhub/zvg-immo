import { getPool } from './db'
import { cacheKey } from './verkehrswert-cache'

export interface ArtifactVersionRef {
  id: number
  platform: string
  externalId: string
  version: number
  setHash: string
}

interface ArtifactVersionRow {
  id: string | number
  platform: string
  external_id: string
  version: number
  set_hash: string
}

function fromRow(row: ArtifactVersionRow): ArtifactVersionRef {
  return {
    id: Number(row.id),
    platform: row.platform,
    externalId: row.external_id,
    version: row.version,
    setHash: row.set_hash,
  }
}

export async function readLatestArtifactVersions(): Promise<Map<string, ArtifactVersionRef>> {
  const db = getPool()
  if (!db) return new Map()
  const { rows } = await db.query<ArtifactVersionRow>(
    `SELECT DISTINCT ON (platform, external_id)
       id, platform, external_id, version, set_hash
     FROM artifact_versions
     ORDER BY platform, external_id, version DESC`,
  )
  return new Map(rows.map((row) => {
    const ref = fromRow(row)
    return [cacheKey(ref.platform, ref.externalId), ref]
  }))
}

export interface ArtifactProcessingState {
  latest: ArtifactVersionRef | null
  parsedArtifactVersionId: number | null
}

/** One-query comparison used by reprocess eligibility and provenance. */
export async function readArtifactProcessingState(
  platform: string,
  externalId: string,
): Promise<ArtifactProcessingState> {
  const db = getPool()
  if (!db) return { latest: null, parsedArtifactVersionId: null }
  const { rows } = await db.query<ArtifactVersionRow & { parsed_artifact_version_id: string | number | null }>(
    `SELECT av.id, av.platform, av.external_id, av.version, av.set_hash,
            (SELECT ad.artifact_version_id
             FROM auction_details ad
             WHERE ad.platform = $1 AND ad.external_id = $2 AND ad.is_latest = true) AS parsed_artifact_version_id
     FROM artifact_versions av
     WHERE av.platform = $1 AND av.external_id = $2
     ORDER BY av.version DESC LIMIT 1`,
    [platform, externalId],
  )
  const row = rows[0]
  if (!row || row.id == null || row.set_hash == null || row.version == null) {
    return { latest: null, parsedArtifactVersionId: null }
  }
  return {
    latest: fromRow(row),
    parsedArtifactVersionId: row.parsed_artifact_version_id == null ? null : Number(row.parsed_artifact_version_id),
  }
}

export function hasUnparsedArtifactVersion(state: ArtifactProcessingState): boolean {
  return state.latest != null && state.latest.id !== state.parsedArtifactVersionId
}
