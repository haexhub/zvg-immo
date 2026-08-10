# Implementation Plans

Generated on 2026-08-09 from commit `abceeb9`. These plans are intentionally
ordered so behavioural tests land before structural changes. Execute each in an
isolated branch/worktree; do not mix them with the currently uncommitted GIS
progress work in the user worktree.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 001 | Patch vulnerable runtime dependencies and public error boundaries | P1 | S | — | DONE (`8d134b3`, PR #385) |
| 002 | Establish one saved-search filter contract | P1 | L | 001 | DONE (`03945c0`, PR #388) |
| 003 | Make outbound notifications durable and abuse-resistant | P1 | L | 001 | DONE (`dff7436`, PR #389) |
| 004 | Make public data reads bounded and cache-only | P2 | L | 002 | DONE (2026-08-09; bounded v1 reads and cache-only map polling) |
| 005 | Split oversized production modules along domain boundaries | P2 | L | 002, 003, 004 | DONE (2026-08-10; behaviour-preserving domain splits and CI size gate) |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED.

## Dependency notes

- Plan 001 was completed in commit `8d134b3` (PR #385): compatible Nuxt/
  Undici upgrades, self-contained Nuxt preparation for lint/typecheck, and
  public error-boundary tests are in `main`.
- Plan 002 pinned the query/filter contract used by alerts, search and the
  later data/read changes in PR #388.
- Plan 003 made data and mail semantics durable in PR #389; it remains a
  dependency of the later size-only refactor.
- Plan 005 is last: it moves tested behaviour but deliberately does not change
  public contracts or product semantics.

## Findings considered and rejected

- The current local `chart.js`/`vue-chartjs` typecheck failure is not planned as
  source work: both packages are present in `package.json` and `pnpm-lock.yaml`
  but absent from this worktree's `node_modules`. A clean frozen install must be
  the executor's first verification gate.
- The uncommitted GIS progress feature is excluded from every plan. Its one
  failing test must be resolved by the owner of that in-progress change before
  merge.
