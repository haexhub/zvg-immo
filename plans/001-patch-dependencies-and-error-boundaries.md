# Plan 001: Patch vulnerable runtime dependencies and public error boundaries

> **Executor instructions**: Work in an isolated branch. Follow every step and
> run every verification command. Update `plans/README.md` only after all done
> criteria pass.
>
> **Drift check (run first)**: `git diff --stat abceeb9..HEAD -- package.json pnpm-lock.yaml server/api server/plugins`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security, dx
- **Planned at**: commit `abceeb9`, 2026-08-09
- **Completed by**: commit `8d134b3` (`Fix: patch dependencies and public error boundaries`, PR #385)

## Completion record

Implemented and merged after this plan was written:

- Nuxt was upgraded to `^4.5.1` and direct Undici to `^8.9.0`; the lockfile
  was regenerated.
- `prepare:nuxt` was added and both `lint` and `typecheck` invoke it.
- `server/utils/public-error.ts` now protects the reviewed public error paths;
  tests were added for the lawyers, watchlist and translation routes.

The plan's remaining text is retained as an implementation record. Do not
execute it again unless a new audit identifies a regression.

## Why this matters

`pnpm audit --prod --audit-level high` reports a critical Nuxt advisory for
the locked Nuxt 4.4.8 and a high Undici advisory for the directly used 8.7.0.
The application is SSR-enabled and imports Undici in production crawler and
document code. Several routes also return raw provider/database error text to
unauthenticated clients, which turns internal failures into reconnaissance
data.

## Current state

- `package.json:36,45` declares `nuxt: ^4.4.8` and `undici: ^8.7.0`; the lock
  pins 4.4.8 and 8.7.0 at `pnpm-lock.yaml:53-55,80-82`.
- Production uses Undici in `server/crawlers/pt/list.ts`,
  `server/crawlers/pt/detail.ts`, `server/crawlers/pt/agent.ts`, and extraction
  utilities.
- `server/api/lawyers.get.ts:32-40`, `server/api/watchlist/index.post.ts:45-51`
  and `server/api/auction/[platform]/[id]/translation.post.ts:289-297` return
  raw upstream error messages. The translation detail is useful to settings
  diagnostics but must not be exposed on the public route.
- CI's real gates are `.github/workflows/ci.yml`: frozen install, `nuxi
  prepare`, lint, `nuxi typecheck`, tests, build.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Clean install | `pnpm install --frozen-lockfile` | exit 0 |
| Audit | `pnpm audit --prod --audit-level high` | no critical/high reachable runtime advisory |
| Lint | `pnpm run lint` | exit 0 |
| Typecheck | `pnpm exec nuxi typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**: `package.json`, `pnpm-lock.yaml`, affected route tests and only
the route/plugin modules that return raw errors.

**Out of scope**: runtime configuration secrets, the current GIS worktree
files, and a framework major-version migration.

## Git workflow

- Branch: `advisor/001-dependency-error-boundaries`
- Commit style follows history, e.g. `Fix: ... (#NNN)`.
- Do not push or open a PR unless an operator explicitly authorizes it.

## Steps

### Step 1: Upgrade only to patched compatible releases

Choose patched Nuxt and Undici versions compatible with the existing Nuxt 4
application, update the manifest and lockfile with pnpm, then inspect the
lockfile to ensure the vulnerable direct versions are gone. Do not use broad
`pnpm update --latest`; retain unrelated resolved versions where possible.

**Verify**: audit command above reports no reachable critical/high issue for
Nuxt or direct Undici; `pnpm exec nuxi prepare` exits 0.

### Step 2: Introduce a stable public-error boundary

Create a small server utility if necessary that logs the original exception
with a route/context prefix and emits a stable German public status message.
Replace raw `error.message` / `data.detail` responses in the public routes
listed above. Retain detailed translation failure text in the database/settings
diagnostic path only, never in the client response. Preserve response status
codes and success payloads.

**Verify**: add or extend colocated Vitest route tests to inject a provider/DB
failure and assert the status plus the stable message, while asserting the
injected detail is absent.

### Step 3: Align local commands with CI

Make `pnpm lint` and `pnpm typecheck` prepare Nuxt types first, or add a
documented shared `prepare:nuxt` prerequisite invoked by both. It must work
from a clean checkout where `.nuxt` is absent; `eslint.config.mjs` currently
reads generated files at lines 4 and 16-20.

**Verify**: remove only generated `.nuxt` content in the disposable worktree,
then run `pnpm run lint` and `pnpm run typecheck`; both must regenerate what
they need and exit 0.

## Test plan

- Route tests for public generic error output and retained translation state.
- A clean-checkout lint/typecheck smoke gate.
- Run the full CI-equivalent command sequence.

## Done criteria

- [x] Nuxt and direct Undici are patched in the lockfile.
- [x] No raw provider/DB message is returned by public routes in scope.
- [x] `pnpm run lint`, `pnpm exec nuxi typecheck`, `pnpm test`, and `pnpm build` pass.

## STOP conditions

- Stop if the compatible Nuxt upgrade requires a public routing/API migration.
- Stop if audit still reports a runtime advisory with no compatible indirect
  update; report the exact dependency path instead of adding a blind override.

## Maintenance notes

Run the production audit in CI at least weekly. New public routes should use
the same error helper rather than returning adapter exceptions directly.
