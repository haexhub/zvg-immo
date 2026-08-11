import { afterEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({ pool: null as { connect: ReturnType<typeof vi.fn> } | null }))

vi.mock('./db', () => ({ getPool: () => dbMock.pool }))

import {
  buildAutomaticRelationships,
  canonicalAddress,
  canonicalCaseNumber,
  readAuctionRelationships,
  rebuildAutomaticAuctionRelationships,
  type RelationshipCandidate,
} from './auction-relationships'

function candidate(overrides: Partial<RelationshipCandidate> = {}): RelationshipCandidate {
  return {
    platform: 'zvg-portal',
    externalId: '8604',
    country: 'de',
    authority: 'Biberach',
    caseNumber: '0002 K 0015/2018',
    address: 'Am Annaweiher 17, 17/1, 88447 Warthausen',
    auctionDateIso: '2026-10-01T09:00:00.000Z',
    ...overrides,
  }
}

describe('auction relationships', () => {
  afterEach(() => {
    dbMock.pool = null
    vi.restoreAllMocks()
  })

  it('canonicalizes only recognized German case-number variants', () => {
    expect(canonicalCaseNumber('2 K 15/18')).toBe('2 k 15/18')
    expect(canonicalCaseNumber('0002 K 0015/2018')).toBe('2 k 15/18')
    expect(canonicalCaseNumber('AZ-unknown')).toBeNull()
  })

  it('requires a specific address before adding a same-address hint', () => {
    expect(canonicalAddress('Am Annaweiher 17, 88447 Warthausen')).toBe('amannaweiher1788447warthausen')
    expect(canonicalAddress('Warthausen')).toBeNull()
  })

  it('links differently formatted copies of the same proceeding', () => {
    const relationships = buildAutomaticRelationships([
      candidate(),
      candidate({ platform: 'zvbawu', externalId: '1330381', caseNumber: '2 K 15/18' }),
    ])

    expect(relationships).toEqual([expect.objectContaining({
      kind: 'same_proceeding',
      confidence: 'high',
      evidence: { sameAuthority: true, sameCaseNumber: true, sameAuctionDate: true },
    })])
  })

  it('keeps different proceedings as an address-only relationship', () => {
    const relationships = buildAutomaticRelationships([
      candidate({ platform: 'mv-zvgcom', externalId: '211451', authority: 'Hamburg-Bergedorf', caseNumber: '417 K 7-24' }),
      candidate({ platform: 'mv-zvgcom', externalId: '211452', authority: 'Hamburg-Bergedorf', caseNumber: '417 K 8-24', auctionDateIso: '2026-10-01T11:00:00.000Z' }),
    ])

    expect(relationships).toEqual([expect.objectContaining({ kind: 'same_address', confidence: 'medium' })])
  })

  it('does not associate a matching case number at a different appointment', () => {
    const relationships = buildAutomaticRelationships([
      candidate(),
      candidate({ platform: 'zvbawu', externalId: '1330381', caseNumber: '2 K 15/18', auctionDateIso: '2026-10-02T09:00:00.000Z', address: 'Andere Straße 1, 88447 Warthausen' }),
    ])

    expect(relationships).toEqual([])
  })

  it('rebuilds automatic relationships in one transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const release = vi.fn()
    dbMock.pool = { connect: vi.fn().mockResolvedValue({ query, release }) }

    await rebuildAutomaticAuctionRelationships(['DE', 'de'])

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FROM auctions a'),
      expect.stringContaining('DELETE FROM auction_relationships'),
      'COMMIT',
    ])
    expect(query.mock.calls[1]?.[1]).toEqual([['de']])
    expect(query.mock.calls[2]?.[1]).toEqual([['de']])
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back a failed relationship rebuild before releasing the client', async () => {
    const failure = new Error('database unavailable')
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [] })
    const release = vi.fn()
    dbMock.pool = { connect: vi.fn().mockResolvedValue({ query, release }) }

    await expect(rebuildAutomaticAuctionRelationships(['de'])).rejects.toThrow(failure)

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FROM auctions a'),
      'ROLLBACK',
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('returns no related auctions when the relationship read fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'))
    dbMock.pool = { connect: vi.fn() }
    Object.assign(dbMock.pool, { query })

    await expect(readAuctionRelationships('zvg-portal', '7265')).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith('[auction-relationships] detail read failed: database unavailable')
  })
})
