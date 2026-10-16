# Plan 002: Establish one saved-search filter contract

> **Executor instructions**: Work in isolation. Preserve existing URL keys and
> saved JSON filter values; do not silently drop a filter. Update the index only
> after every verification passes.
>
> **Drift check (run first)**: `git diff --stat abceeb9..HEAD -- composables/useAuctionSearchState.ts lib/auction-filters.ts server/utils/auction-search-filters.ts server/utils/alert-matching.ts components/search`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-patch-dependencies-and-error-boundaries.md`
- **Category**: bug, tech-debt, tests
- **Planned at**: commit `abceeb9`, 2026-08-09
- **Completed by**: commit `03945c0` (`Unify saved search filter contract`, PR #388)

## Completion record

Implemented and merged in PR #388. The shared filter contract now covers the
saved-search, discovery and alert paths. This plan is retained as a historical
implementation record; do not reopen it while working on subsequent plans.

## Why this matters

The same search filter has independent state, URL, reset, count, public-SQL
and alert implementations. Geo and nearby filters are serialized by the UI but
lost when alerts deserialize saved searches, so recipients can receive alerts
for auctions that do not match their selected location constraints. This plan
creates a typed shared contract before any further filter work.

## Current state

- `composables/useAuctionSearchState.ts:51-85,143-172,200-230,272-358` repeats
  every field across setup, count, reset, serialization and hydration.
- Geo/nearby keys (`nearSea`, `nearLake`, `nearRiver`, `nearMountain`,
  `nearAirport`, `urbanRural`, `nearLat`, `nearLng`, `nearRadius`) are emitted
  at `:290-300` and applied to discovery SQL at
  `server/utils/auction-search-filters.ts:138-186`.
- `lib/auction-filters.ts:11-47` and `server/utils/alert-matching.ts:26-81`
  implement only the older in-memory contract; alerts call it at `:129-143`.
- Existing filter unit tests are in `server/utils/auction-search-filters.test.ts`;
  alert tests currently cover only legacy parsing in `alert-matching.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm test -- server/utils/auction-search-filters.test.ts server/utils/alert-matching.test.ts` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |
| Typecheck | `pnpm exec nuxi typecheck` | exit 0 |

## Scope

**In scope**: a new shared non-Vue filter contract module, the state
composable, public filter builder, legacy in-memory evaluator, alert matcher,
their tests, and `components/search/SearchBar.vue` only where it duplicates
filter metadata.

**Out of scope**: changing URL names, changing saved searches' JSON storage
format without backwards-compatible parsing, and the GIS progress worktree.

## Steps

### Step 1: Characterize current and missing behaviour

Add tests that parse saved filter objects containing every existing legacy key
and each geo/nearby key. For the latter, write failing regression tests proving
that an auction outside the requested distance/location cannot be notified.
Use the existing mock style in `alert-matching.test.ts`; do not send mail.

**Verify**: the new geo/nearby alert cases fail against the pre-refactor code
for the expected reason, while all existing filter tests stay green.

### Step 2: Define one typed, pure contract

Create a `lib/` module owning the URL key list, defaults, safe parsing,
serialization, active-filter classification and reset defaults. It must have no
Vue/Nitro imports. Preserve `region` UI keys versus the server's resolved
`regionNames` distinction explicitly rather than hiding it in casts.

Migrate `useAuctionSearchState` to use the contract for hydration,
serialization, active count and reset. Keep reactive refs/UI wiring in the
composable; do not make a generic UI framework.

**Verify**: add round-trip tests for empty/default values, lists, all numeric
ranges, LLM/display flags, geo keys and nearby coordinates. Existing links
must serialize back to the same canonical query.

### Step 3: Make discovery and alert evaluation honest

Use the contract to parse the public query and stored saved-search values.
For alert matching, evaluate geo/nearby criteria against the database-backed
search predicate or another complete evaluator with access to the same
precomputed metrics. If a criterion cannot be correctly evaluated for a fresh
batch, reject that key when saving a search with a clear 400 response; never
silently ignore it. Preserve best-effort alert error isolation.

**Verify**: tests demonstrate parity for a representative auction set: each
supported filter accepts/rejects the same data for discovery and alerts.

### Step 4: Remove duplicated field matrices

Delete superseded manual arrays/branches after all callers use the contract.
Keep only presentation-specific labels in `SearchBar.vue`.

**Verify**: `rg -n "nearSea|nearAirport|nearRadius" composables/useAuctionSearchState.ts` shows no duplicate URL parsing/serialization branches; full test/typecheck/lint gates pass.

## Done criteria

- [x] Every persisted URL filter has one parser/serializer/default owner.
- [x] Alerts either honour every saved filter or reject unsupported filters.
- [x] Regression tests cover false-positive geo/nearby alert prevention.
- [x] Public URL compatibility is retained.

## STOP conditions

- Stop if a saved geo filter cannot be evaluated against fresh crawl data with
  the same semantics as discovery; present the unsupported-key migration choice.
- Stop if proposed state changes would invalidate existing bookmarked URLs.

## Maintenance notes

Any new filter begins in the pure contract and gets parity tests before UI work.
Reviewers should specifically compare saved-search and public-search semantics.
