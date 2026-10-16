import { describe, expect, it } from 'vitest'
import { parsePagination } from './data-api-pagination'

describe('parsePagination', () => {
  it('clamps page size and keeps valid pages', () => {
    expect(parsePagination({ page: '3', pageSize: '500' }, 30, 60)).toEqual({ page: 3, pageSize: 60 })
    expect(parsePagination({}, 30, 60)).toEqual({ page: 1, pageSize: 30 })
  })

  it('falls back instead of producing an OFFSET Postgres cannot represent', () => {
    // 1e300 would serialize as "3e+301" (invalid bigint) and turn into a 500.
    expect(parsePagination({ page: '1e300', pageSize: 'Infinity' }, 30, 60)).toEqual({ page: 1, pageSize: 30 })
    expect(parsePagination({ page: '1e18' }, 30, 60)).toEqual({ page: 1, pageSize: 30 })
  })
})
