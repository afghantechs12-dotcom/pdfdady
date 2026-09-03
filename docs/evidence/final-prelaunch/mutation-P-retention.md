# Mutation P — the save-intent horizon

Gate: `npx vitest run src/infrastructure/jobs/PdfToolWorkerHandler.test.ts`
(13 tests green at `1d36b30`).

Like B, C and D, this row mutates code one of this audit's fixes introduced, so it
lives beside them rather than in the A/E–O table. Its subject is §K's finding:
`workspace_save_intents` gained a row per save-to-workspace operation and nothing
ever deleted one.

## P1 — the recurring sweep stops pruning save intentions

The `pruneBefore` call removed from `createFileRetentionHandler`, i.e. the
behaviour this repository shipped with until `1d36b30`:

```ts
      try {
        // MUTATION P1: the sweep no longer prunes save intentions.
      } catch (err) {
```

Observed: **Tests 1 failed | 12 passed (13)**

- × FileRetentionHandler > prunes save intentions past the horizon and keeps the ones inside it

The three sibling assertions stayed green, which is the point of running it: the
file-purge test, the reschedule test and the horizon-length test all pass while the
table grows without limit, so none of them was ever the guard for this.

Reverted with `git checkout -- src/infrastructure/jobs/PdfToolWorkerHandler.ts`;
`git diff --stat` empty afterwards, and the three files re-run green (37 tests).

## What P1 could not prove, and what now does

That the sweep is *registered*. P1 breaks the handler; a deployment that never
registers `file-retention` keeps P1's gate green while nothing expires at all —
not a stored output, not an intention row. Nothing in this repository asserted
that wiring: `ensureWorkerReady` had no test, and every test that touches it
mocks it away (`storedOutputFidelity.test.ts:60`).

`src/infrastructure/jobs/workerBootstrap.test.ts` is that assertion, and it is
behavioural rather than "register was called" — it RUNS the handler the bootstrap
registered and requires it to prune. Two more mutations check it:

| # | Mutation | Applied to | Observed |
|---|---|---|---|
| P2 | The retention handler is never registered on the worker | `workerBootstrap.ts` | **RED** — 2 failed / 1 passed. *registers every job type the product depends on* + *registered a handler that really prunes save intentions* |
| P3 | The first sweep is scheduled in the past instead of the future | `workerBootstrap.ts` | **RED** — 1 failed / 2 passed. *schedules the first sweep, in the future rather than immediately* |

Both reverted with `git checkout --`; `git status --short` clean afterwards.

What none of the three reaches: that a *deployed* process ever calls
`ensureWorkerReady`. It is called lazily from the tool and job routes, so the
proof of that is a runtime observation — a `file-retention` row appearing in the
jobs table after real traffic — recorded with the final probe runs, not here.
