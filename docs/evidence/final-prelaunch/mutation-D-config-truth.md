# Mutation D — the production gate's database claim

Fix commit: `b6e3961` *Audit P0: the production gate stops asking for a database it cannot open*
Gate for every row below: `npx vitest run src/infrastructure/config/env.test.ts instrumentation.test.ts`
Baseline before mutation: 31 + 7 = 38 passed, 0 failed.

| # | Mutation | Applied to | Observed | Reverted by |
|---|---|---|---|---|
| D1 | Delete the wrong-provider refusal branch (`else if (!databaseUrl.startsWith(DATABASE_URL_PREFIX))`) | `src/infrastructure/config/env.ts` | **RED** — 1 failed / 30 passed. `env.test.ts:129` *"refuses a DATABASE_URL for an engine this build cannot open"* | `git checkout --` |
| D2 | Delete the relative-`file:`-path refusal branch | `src/infrastructure/config/env.ts` | **RED** — 1 failed / 30 passed. `env.test.ts:136` *"refuses a relative SQLite path in production, which a deploy would delete"* | `git checkout --` |
| D3 | Restore the guessed label: `url.startsWith("file:") ? "sqlite" : "postgres"` | `src/infrastructure/config/env.ts` (`databaseEngineLabel`) | **RED** — 1 failed / 37 passed. `env.test.ts:153` *"labels a URL the gate would refuse as unsupported, never as another engine"* | `git checkout --` |
| D4 | Swap the schema's datasource `provider = "sqlite"` → `"postgresql"` | `prisma/schema.prisma` | **RED** — 1 failed / 30 passed. `env.test.ts:159` *"expects the scheme of the provider prisma/schema.prisma actually declares"* | `git checkout --` |

D4 is the anti-vacuity check: it proves the schema tie is a real read of the file
rather than a constant compared with itself. A future provider swap fails here
instead of silently leaving the gate and the boot log asserting the old engine.

## What no mutation could reach

`startupGate`'s `db=` label for a **refused** URL in **production** is
unreachable by construction: the gate terminates the process before the summary
prints. D3's red comes from the exported `databaseEngineLabel` unit case, which
covers the reachable one — a non-production run, where the gate does not fire and
a developer with a `postgresql://` URL would otherwise be told `db=postgres` by a
build that cannot open one.

## Defect this fix addresses (verified in this tree, before the fix)

`prisma/schema.prisma:16` declared `provider = "sqlite"` while
`productionProblems` told the operator *"DATABASE_URL is not set. Point it at
PostgreSQL."* A Prisma datasource accepts only its own provider's URLs and
rejects a foreign one when it **connects**, not at startup. An operator who
followed the instruction got a deployment that passed the gate, logged
`configuration OK — env=production db=postgres`, answered the Dockerfile's
`HEALTHCHECK` (`/api/health`, a static `{ok:true}` that touches nothing) and
therefore reported a **healthy container** — while every request that read the
database failed. `/api/health/ready` does ping the datasource and would have gone
503, but nothing in the shipped deployment consults it: compose gates on the
liveness check, so the traffic flows either way. Both suites asserted the false belief:
`setValidProductionEnv` in `env.test.ts` and `instrumentation.test.ts`, plus
`deployBehindProxy` in `workspaceCsrfProxyOrigin.test.ts`, all used a
`postgresql://` URL, and one test was NAMED
`"accepts a DATABASE_URL in production (e.g. PostgreSQL)"`.

The engine question itself — SQLite vs PostgreSQL for launch — is **LAUNCH
DECISION REQUIRED**, not something this commit decides. The fix makes the gate
agree with the schema the build actually ships; it does not choose the schema.
