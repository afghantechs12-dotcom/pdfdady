# §8 mutation testing — thirteen properties, thirteen red gates

`node scripts/mutation-gate.mjs` applies one mutation, runs only the gate that claims to own
that property, requires a **non-zero exit with at least one failed test**, and reverts with
`git checkout --` (or a delete, for the mutation that adds a file). The tree must be clean
before the run and is re-checked after every revert. Evidence: `mutations.{log,json}`.

| id | property removed | file | gate | red? | what failed |
|---|---|---|---|---|---|
| M1 | class A refuses every body (`CLASS_A_MAX_BYTES` 0 → 120 MiB) | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 4 | refuses any body on a class A path; method-agnostic; forged headers |
| M2 | chunked on A/B is 411, unread | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 1 | refuses a chunked body on class A and B with 411, unread |
| M3 | the ceiling is inclusive (`>` → `>=`) | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 1 | accepts a class B body at the ceiling and refuses one byte more |
| M4 | `Content-Length` read as Node's parser reads it (digits only → `Number()`) | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 1 | refuses a malformed Content-Length with 400 |
| M5 | class C is exactly the matcher's five exclusions (`^/api/tools/[^/]+$` dropped) | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 4 | five paths in class C; agrees with proxy.ts; same number of carve-outs |
| M6 | the seam applies the policy to **every** method (GET/HEAD skipped) | `ingress/guard.mjs` | `ingress/guard.test.ts` | exit 1, 1 | wraps the server Next creates, refusing bodies and passing everything else through |
| M7 | a refusal discloses nothing (class named in the message) | `ingress/policy.mjs` | `ingress/policy.test.ts` | exit 1, 1 | answers identically for a page, a real route and a path with no route |
| M8 | shutdown releases while the lease still reads held | `ingress/guard.mjs` | `ingress/guard.test.ts` | exit 1, 1 | calls the release while the lease still reads held, not after |
| M9 | the exit waits for the release | `ingress/guard.mjs` | `ingress/guard.test.ts` | exit 1, 1 | holds the exit until the release settles, then exits with the given code |
| M10 | acquisition is a compare-and-swap (`OR: [holder, expired]` dropped) | `src/infrastructure/config/instanceLease.ts` | `instanceLease.test.ts` | exit 1, 1 | takes over a lease that expired more than the grace margin ago |
| M11 | an unguarded production process refuses to start | `src/infrastructure/config/ingressState.ts` | `ingressState.test.ts` | exit 1, 1 | refuses a production process that was not started through `ingress/server.mjs` |
| M12 | the container starts the guarded entry (`CMD` → `exec node server.js`) | `Dockerfile` | `deploymentArtifact.test.ts` | exit 1, 2 | carries the migration toolchain; starts through the ingress guard, and ships it |
| M13 | a new body-consuming route cannot appear without a policy (adds `app/api/_mutation_probe/route.ts` calling `req.json()`) | new file | `ingress/bodyRoutes.test.ts` | exit 1, 1 | lists every route that can receive a request body |

`13/13 mutations were caught`, exit 0. Every revert verified: tracked files matching HEAD and
`app/api/_mutation_probe` gone.

## M6 was NOT caught on the first run, and that is the point

The first run reported `12/13 … NOT CAUGHT: M6`: making the seam skip GET and HEAD left
`ingress/guard.test.ts` green at exit 0. `ingressDecision`'s own test *does* pin
method-agnosticism — but it calls the policy directly, so it can never see a seam that
declines to consult it. The gap was in the gate, not in the product, and it was closed with one
assertion in the existing seam test: a raw `GET /` carrying `content-length: 64` must answer
413 with no inner header (`fetch` refuses to send a GET body, hence `http.request`). M6 has
been red since. The 13/13 log is the rerun; the first run's finding is recorded here because a
mutation harness that only ever prints its final number is worth very little.

## What the live probes contribute that these cannot

A mutation to `ingress/policy.mjs` cannot show what the *runtime* retains. The live vacuity
proof for that is the baseline run itself: the same `scripts/ingress-probe.mjs`, with the same
post-fix expectations, scored `6/18` against the unguarded artifact and `25/25` against the
guarded one, and `scripts/singleton-probe.mjs` scored `3/8` (two of those three vacuously)
against the unguarded entry and `8/8` against the guarded one. See `BASELINE.md` and
`RESULTS.md`.
