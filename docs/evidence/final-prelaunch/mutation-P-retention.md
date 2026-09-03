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

## What this row cannot prove

That the sweep is *registered*. P1 breaks the handler; a deployment that never
registers `file-retention` would keep every gate green. `workerBootstrap.ts`
resolves `Tokens.WorkspaceSaveIntentRepository` into it, and the dependency is
required rather than optional precisely so a forgotten wiring is a type error
instead of an unbounded table — but the registration itself is proved by the
worker's own bootstrap test, not here.
