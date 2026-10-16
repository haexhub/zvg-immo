# Plan 004: Make public data reads bounded and cache-only

> **Executor instructions**: Preserve public response contracts and route
> status codes. Benchmark only after semantic tests exist; do not add database
> indexes without an `EXPLAIN` against representative data.
>
> **Drift check (run first)**: `git diff --stat abceeb9..HEAD -- server/api/data/v1 server/utils/auction-record.ts server/api/auctions-geo.get.ts server/utils/geocode.ts server/utils/external-data/location-enrichment.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/002-unify-search-filter-contract.md`
- **Category**: bug, perf, tests
- **Planned at**: commit `abceeb9`, 2026-08-09
- **Completed**: 2026-08-09 — verified on an isolated worktree/branch

## Why this matters

The authenticated auction API reads the complete internal auction aggregate,
filters in Node and slices after allocation. It therefore grows with the whole
database and also includes expired auctions despite its documented current-
auction purpose. Separately, public map polling can trigger external geocoding,
and one detail request reads every enrichment JSON record into memory.

## Current state

- `server/api/data/v1/auctions.get.ts:30-42` calls `readAuctionRecords`, filters
  in memory and slices after pagination; `server/utils/auction-record.ts:102-132,
  268-276` selects broad descriptions, insights, attachments and state without
  SQL limit/offset.
- Public discovery correctly excludes expired auctions at
  `server/utils/auction-search-filters.ts:62-68`; the data API does not.
- `server/api/data/v1/observations.get.ts:44-52` uses `SELECT *` although
  `toPublicObservation` consumes only scalar columns.
- `server/api/auctions-geo.get.ts:78-139` accepts public `fetch=1`, calls
  geocoding for up to 5,000 rows, while `server/utils/geocode.ts:98-113`
  serializes upstream work at 1.1-second spacing.
- `readLocationEnrichment` at
  `server/utils/external-data/location-enrichment.ts:25-52` first loads and
  retains the entire table for a single detail lookup.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm test -- server/api/data/v1 server/api/auctions-geo.get.test.ts server/utils/external-data/location-enrichment.test.ts` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Lint/typecheck | `pnpm run lint && pnpm exec nuxi typecheck` | exit 0 |

## Scope

**In scope**: data v1 route/repository tests, narrow database read utilities,
history projection, geocode/map request control, enrichment lookup/cache tests.

**Out of scope**: changing v1 JSON fields, adding billing quotas, deleting
historical observations, or altering crawler schedules.

## Steps

### Step 1: Characterize public contracts

Add direct route tests for data v1 auctions (country, region, platform,
property type, withdrawn, expired/current, total, deterministic pagination),
single detail and observations. Use mocked database adapters in the established
route-test style; there are currently no data-v1 route tests.

**Verify**: tests encode the existing success payload and explicitly assert
expired-but-not-withdrawn auctions are excluded from the collection result.

### Step 2: Create narrow SQL repositories

Implement a dedicated data-API query selecting only `PublicAuction` fields,
with parameterized filters, deterministic order, `COUNT(*)`, `LIMIT` and
`OFFSET`. Keep `readAuctionRecord(s)` for internal rich detail callers; do not
overload it with flags. Use the shared filter contract where semantics overlap.
Replace observation `SELECT *` with exactly the scalar projection consumed by
`toPublicObservation`.

**Verify**: tests assert generated query parameters include limit/offset and
the mapper receives no `payload`; public response shape remains unchanged.

### Step 3: Remove public cache-miss geocoding

Make `/api/auctions-geo` cache-only for anonymous requests. Move cache-miss
work to the existing exclusive scheduled/admin geocode task, or require an
authenticated, strictly budgeted trigger if product requires interactive
geocoding. Update `pages/search.vue` polling to observe background progress
without passing `fetch=1`; propagate client cancellation to any retained work.

**Verify**: a public request with `fetch=1` makes zero upstream geocoder calls;
map markers/progress still render from cached and unresolved states.

### Step 4: Key the enrichment read cache

Keep `readLocationEnrichmentCache()` for batch enrichment only. Make detail
`readLocationEnrichment(platform, id)` issue a keyed query, optionally with a
bounded TTL/LRU. Preserve invalidation on writes and write tests for cache hit,
miss and post-write freshness.

**Verify**: detail lookup SQL has both identity predicates and never performs
the full-table query.

## Done criteria

- [x] Data-v1 collection work is bounded by page size, not total auctions.
- [x] The current-auction contract excludes expired listings consistently.
- [x] Public map reads cannot enqueue external geocoding.
- [x] Detail enrichment reads do not materialize the whole table.
- [x] All focused and full verification commands pass.

## STOP conditions

- Stop if external data consumers rely on expired listings in the v1 collection;
  propose a documented explicit history parameter/version instead.
- Stop if changing map geocoding requires an unapproved UX/product decision.

## Maintenance notes

Review SQL plans with production-like cardinality before adding indexes. Keep
rich internal record loading separate from public projection reads.
