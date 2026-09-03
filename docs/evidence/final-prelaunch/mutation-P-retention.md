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

---

# Mutation P4–P7 — the `sessions` horizon

Gate: `npx vitest run src/infrastructure/auth/LocalSessionProvider.test.ts
src/infrastructure/jobs/PdfToolWorkerHandler.test.ts
src/infrastructure/jobs/workerBootstrap.test.ts`
(**22 tests green at `371f4ef`**, the commit that adds the fix).

Subject: §K's second finding. `sessions` gains a row on every login and loses one
only on an explicit logout — no cascade, no sweep, no TTL job. `get` already
refuses an expired token, so a stale row was never an access risk, which is
precisely why nothing surfaced it: the table only ever grew. Same shape as the
save-intent finding above, in an authentication table.

| # | Mutation | Applied to | Observed |
|---|---|---|---|
| P4 | The sweep no longer calls `pruneExpired` | `PdfToolWorkerHandler.ts` | **RED** — 2 failed / 20 passed. *prunes expired auth sessions and reports the count* + *registered a handler that really prunes save intentions and sessions* |
| P5 | The predicate inverted, `lt` → `gt` (deletes the live rows, keeps the expired ones) | `LocalSessionProvider.ts` | **RED** — 3 failed / 19 passed. All three behavioural rows of `pruneExpired` |
| P6 | The predicate dropped entirely — `deleteMany({})` | `LocalSessionProvider.ts` | **RED** — 2 failed / 20 passed. *deletes expired rows, keeps live ones* + *is a no-op when nothing has expired* |
| P7 | The provider is still resolved from the container, but an inert `{ pruneExpired: async () => 0 }` is handed to the handler | `workerBootstrap.ts` | **RED** — 1 failed / 21 passed. *registered a handler that really prunes save intentions and sessions* |

Each applied singly and reverted with `git checkout -- <file>`; `git diff --stat`
empty after each, `git status --short` carrying no source line at the end, and the
gate re-run **22/22 green** at `371f4ef`.

## What each one buys, since three of them overlap on paper

**P4 and P7 are not the same mutation.** P4 breaks the handler and is caught in two
places. P7 leaves the handler correct and breaks only the wiring — and it
**passes `tsc --noEmit` (exit 0)**, which is the whole reason it is here: `sessions`
is a required dependency, so a *missing* argument is a compile error and needs no
test, but a *resolved-then-discarded* one compiles silently. That is the failure
this repository has already shipped once (a policy with green tests and a consumer
that never called it), and only the behavioural bootstrap assertion sees it.

**P5 and P6 separate the two ways one comparison can be wrong.** P6 (no predicate)
is caught by the anti-vacuity line — `findMany` must return exactly the live token,
not "the expired ones are gone" — and P5 (inverted) is caught by every row,
including the no-op case, which is the one that would otherwise let a prune that
deletes live sessions look like a prune that works.

**What P4–P7 do NOT reach**, stated for the same reason the section above states
its own gap: that the storage type on the other side of the ORM is what the
predicate assumes. `lt` is compiled to SQL by Prisma, and Prisma writes SQLite
`DateTime` as INTEGER milliseconds; a value that lands in that column as TEXT sorts
after every integer, so the same source line would delete nothing or everything.
No mutation of the source can show that. `LocalSessionProvider.test.ts` asserts it
directly — `select typeof(expiresAt)` must read `integer` — against a real migrated
database rather than a fake, because a hand-written double comparing two JS `Date`s
calls every one of those cases green. This audit hit that exact defect in its own
retention probe (`/tmp/audit-retention-run1-typedefect.log`), which is why it is
asserted rather than assumed.
