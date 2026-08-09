# Plan 005: Split oversized production modules along domain boundaries

> **Executor instructions**: This is a behaviour-preserving refactor. Do not
> combine it with feature changes. Every production `.ts`, `.vue` or `.mjs`
> file must end at 500 lines or fewer, excluding generated files and tests.
>
> **Drift check (run first)**: `git diff --stat abceeb9..HEAD -- server/tasks/reprocess.ts server/tasks/enrich.ts server/utils/app-settings.ts server/utils/extract/gemini-batch.ts server/utils/auction-details.ts server/utils/external-data/eu-flood-risk.ts components/Auction/DetailMap.client.vue pages/admin/auktion/[platform]/[id].vue`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-unify-search-filter-contract.md`, `plans/003-durable-outbound-notifications.md`, `plans/004-bound-public-data-read-paths.md`
- **Category**: tech-debt, tests
- **Planned at**: commit `abceeb9`, 2026-08-09

## Why this matters

Eight production modules exceed the requested 500-LoC maximum. The largest,
`server/tasks/reprocess.ts` (1,049 lines), mixes candidate selection, document
image construction, rules/LLM execution, retry classification, batch
submission and orchestration. Splitting at existing domain boundaries makes
future changes reviewable without creating artificial one-function files.

## Current state

Measured non-generated production files over 500 lines:

| Lines | File | Existing logical seams |
|---:|---|---|
| 1049 | `server/tasks/reprocess.ts` | candidates (205), image/input build (268/315), single auction (442), orchestrator (598) |
| 612 | `server/tasks/enrich.ts` | task wrapper and enrichment worker flow |
| 605 | `pages/admin/auktion/[platform]/[id].vue` | load/session, trial/version actions, archive UI |
| 549 | `server/utils/app-settings.ts` | generic setting I/O, countries, token limits, LLM profiles/assignments, display/kill switch |
| 523 | `server/utils/extract/gemini-batch.ts` | quota policy, request construction, submit/poll/result parsing |
| 517 | `server/utils/auction-details.ts` | read mappings, version reads, optimistic writes |
| 512 | `components/Auction/DetailMap.client.vue` | label/style helpers, ArcGIS layers, overlay assembly, map lifecycle/template |
| 506 | `server/utils/external-data/eu-flood-risk.ts` | source paging/import, parsing, cache adapter, assessment |

Representative conventions:

- Tests are colocated, e.g. `server/tasks/reprocess.test.ts` and
  `server/utils/app-settings.test.ts`.
- Public module entrypoints are imported by routes/tasks; preserve their named
  exports and signatures.
- `runExclusiveTask`, cancellation and task-result shapes are load-bearing for
  reprocess/enrich; see `server/tasks/reprocess.ts:442,598`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Size gate | `find server components composables pages lib -type f \( -name '*.ts' -o -name '*.vue' -o -name '*.mjs' \) ! -name '*.test.ts' -print0 \| xargs -0 wc -l \| awk '$2 != "total" && $1 > 500 { print; bad=1 } END { exit bad }'` | exit 0, no production file >500 |
| Focused tests | `pnpm test -- server/tasks/reprocess.test.ts server/tasks/enrich.test.ts server/utils/app-settings.test.ts server/utils/extract/gemini-batch.test.ts server/utils/auction-details.test.ts server/utils/external-data/eu-flood-risk.test.ts components/Auction/Map.client.test.ts` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Lint/typecheck/build | `pnpm run lint && pnpm exec nuxi typecheck && pnpm build` | exit 0 |

## Scope

**In scope**: the eight files above, their newly extracted sibling modules/
components, their existing tests and narrowly necessary import callers.

**Out of scope**: changing APIs, database schemas, source semantics, i18n text,
the current uncommitted GIS work, and test files solely to evade the size gate.

## Steps

### Step 1: Lock exports and characterize hotspots

Before moving code, add tests only where an extracted seam lacks direct
coverage: reprocess candidate/input helpers, app-settings coercion/profile
assignment, Gemini quota/request/result parsing, auction-detail mapping/version
conflict, flood-risk import/assessment, admin action error states and map
overlay construction. Snapshot no large payloads; assert public behaviour.

**Verify**: focused test command passes before each file move.

### Step 2: Split server pipelines and repositories

Extract cohesive siblings while leaving small public facades:

- `reprocess-candidates.ts`, `reprocess-input.ts`, `reprocess-single.ts` under
  `server/tasks/`; retain `reprocess.ts` as task registration and orchestration.
- `enrich-worker.ts` / `enrich-persistence.ts`; retain the task registration
  and `runEnrich` public entrypoint in `enrich.ts`.
- `app-settings-store.ts`, `app-settings-llm.ts` and
  `app-settings-preferences.ts`; retain compatibility re-exports from a facade
  only if route imports make a staged migration safer.
- `gemini-batch-quota.ts` and `gemini-batch-client.ts` with a compact
  orchestrating facade.
- `auction-details-read.ts` and `auction-details-write.ts`, preserving
  optimistic-version semantics and all current exports.
- `eu-flood-risk-import.ts`, `eu-flood-risk-cache.ts` and assessment helpers.

Do one module family at a time and run its focused tests before the next.

**Verify**: each facade and every extracted production file is <=500 lines;
all current imports compile without import cycles.

### Step 3: Split UI by rendered responsibility

Extract admin page sections into local components under
`components/admin/auction/` (header/technical summary, trial controls, version
history, archive controls). Keep the page responsible only for route params,
page-level loading and layout.

For `DetailMap.client.vue`, move pure overlay style/label and ArcGIS layer
construction to testable `lib/` or adjacent TypeScript helpers, and move the
control panel/legend into small presentational components only if props remain
clear. Keep OpenLayers lifecycle ownership in one component to avoid duplicate
event listener cleanup.

**Verify**: existing map test plus new pure-helper tests pass; inspect that
`onBeforeUnmount` still removes the map exactly once.

### Step 4: Enforce the limit without churn

Add a CI size-check step using the exact size command above, excluding tests,
generated directories, migrations and vendored code. Do not add a blanket
lint-disable. Keep all source files at <=500 lines, including facades.

**Verify**: the size command passes locally and in CI alongside lint,
typecheck, test and build.

## Done criteria

- [ ] No in-scope production source file exceeds 500 lines.
- [ ] Every extraction has a coherent domain boundary and no new circular imports.
- [ ] Existing public entrypoint exports/route payloads are unchanged.
- [ ] Focused tests, full tests, lint, typecheck, build and the CI size gate pass.

## STOP conditions

- Stop if a proposed extraction requires changing a public API or database
  schema; defer it to a dedicated plan.
- Stop if keeping one OpenLayers lifecycle after component extraction is not
  possible without duplicated listeners; retain that lifecycle module and
  reduce size elsewhere.
- Stop if the only way below 500 lines is splitting a tightly coupled routine
  into opaque wrapper files; report the exception with rationale instead.

## Maintenance notes

The line limit is a guardrail, not a reason to proliferate files. New code
belongs next to the domain extraction that owns it; reviewers should reject
facade modules that quietly grow back into god files.
