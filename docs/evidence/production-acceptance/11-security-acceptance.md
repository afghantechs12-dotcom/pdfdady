# Stage 8 — security acceptance

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b` (Stage 7 = `ecf51ee`)
**Artifact:** `BUILD_ID DIi1m4KbzBmf96popnixW`, the same cold build Stage 7 measured.
**Measurements:** `11-legacy-job-ownership.log`, `11-proxy-parity.log`, `11-csp.log`,
`11-upload-abuse.log`, `11-billing.log`, `11-usage-quota-browser.log` (this directory).
**Topology:** origin `http://127.0.0.1:3002` behind `scripts/tls-front.mjs` on
`https://192.168.0.175:3001` (self-signed), plus four further production servers the
probes spawn themselves on 3141/3142 and 3171/3172. Every database, storage root and
admin store under `/tmp` or the OS temp directory. No real customer document, no live
Stripe call, no production credential.

## What Stage 8 has to answer

1. Can one caller reach another caller's job, document or organization?
2. Does the deployment behave the same through the proxy as it does directly — and is
   an excluded path still a protected path?
3. Are the security headers and the CSP the ones the artifact was built with, on every
   route group including the ones middleware deliberately does not run for?
4. Is upload abuse refused *before* the body is read, and does a refusal leave no state?
5. Can entitlement be obtained without a signature-verified webhook?
6. Are the plan ceilings enforced against the browser, not just against a test client?
7. Are there known vulnerabilities in what ships?

## 1. Measurements

| Probe | Command | Result | Exit |
|-------|---------|--------|------|
| Legacy job ownership | `node scripts/legacy-job-ownership-probe.mjs` (pipeline **off**) | 25/25, 0 failed, 0 skipped | 0 |
| Proxy parity | `node scripts/proxy-parity-probe.mjs` | 37/37 | 0 |
| CSP end to end | `node scripts/csp-probe.mjs --server-log /tmp/pa-stage8-origin.log` | 118/118 | 0 |
| Upload abuse | `node scripts/upload-abuse-probe.mjs` | 32/32 (L0–L13) | 0 |
| Billing trust boundary | `node scripts/billing-probe.mjs` | 78/78, 3 ENVIRONMENT-LIMITED | 0 |
| Usage ceiling in a browser | `node scripts/usage-quota-browser-probe.mjs` | 45/45 | 0 |
| Dependency vulnerabilities | `npm audit`, `npm audit --omit=dev` | **0 vulnerabilities** of 486 dependencies (158 prod) | 0 |

`IMAGE CVE SCAN: NOT EXERCISED — NO SCANNER.` No `trivy`, `grype`, `syft`, `snyk`,
`docker` or `podman` on this machine, so the base image's own OS packages are unscanned.
`npm audit` covers the application's dependency tree only. This is the same limitation
Stage 3 recorded for execution, narrowed to CVEs: a row for the operator's own registry
scan, not something this run can supply.

## 2. What the six probes establish

**Ownership is not derived from anything the caller sends.** A stranger is refused on
every legacy job endpoint with **404, never 403** — the status itself does not confirm
that the job exists — while the owner's access to the same job survives all of it,
including the signed download. The pipeline-off configuration is deliberate here: this
is the shipped default, and the legacy path is the one a real visitor meets today.

**An excluded path is still a protected path.** All five matcher-excluded route groups
(`/tools`, `/upload`, `/jobs`, `/attach`, `/version`) carry the six security headers and
the build-time CSP; a trailing slash is redirected *before* middleware so it cannot
re-enter the matcher; case and percent-encoded spellings of the excluded prefixes reach
no upload handler at all (404/405, never 2xx, never 5xx) while the canonical spelling
does — the control that stops "404 everywhere" from reading as a pass. Direct and
through-proxy answers agree on all 37 rows.

**The CSP is the artifact's, and violations arrive.** 118/118 over four phases: headers
from the real artifact, a browser walk, the report endpoint end to end, and violation
classification. The report-to endpoint for `/_next/static/*` is baked at build time from
`NEXT_PUBLIC_SITE_URL` — the one value that is both a build and a runtime input.

**Upload abuse is refused before the body is read.** An anonymous 8 MiB upload answers
401 with the body still arriving; a declared 200 MiB answers 413 before any body; an
authenticated chunked 26 MiB with no `Content-Length` is cut off by the stream with RSS
bounded; eight concurrent 8 MiB offers (64 MiB) all answer 401 with RSS bounded; and
**L13 confirms no storage, database, ingestion, version or audit row from any anonymous
request** — the whole-run delta is exactly the throwaway account's own uploads.

**Entitlement comes only from a verified webhook.** 78/78: a redelivered event applies
once, a stale event cannot overwrite newer state, an unmapped price grants no paid plan
and no payload grants Business, ownership is read from the stored customer and never from
the event's metadata, metadata cannot move a subscription onto a second tenant, returning
from the provider grants nothing, and the checkout success query is not entitlement at any
layer. Section 9 is the control: Pro *can* still be granted, so the refusals above are
refusals rather than a broken path.

**The ceiling is enforced against a real browser.** 45/45, including the pair that matters:
an over-ceiling submission is refused in `enforce` and the *same* submission on the *same*
exhausted fixture is admitted with the shipped default (`observe`), where the overage is
recorded rather than refused.

## 3. The defect this stage found: a fourth launcher, rotted the same way

`scripts/billing-probe.mjs` exited **2** on first run. Not a billing failure — its spawned
server never started:

```
[startup] PDFDadi refused to start.
Refusing to start: 1 production configuration problem.
  - DEPLOYMENT_TOPOLOGY is not set to "single-instance". …
```

The gate worked. The launcher was written before `DEPLOYMENT_TOPOLOGY` existed (Phase 6)
and was never updated, so it composed an incomplete production environment. This is the
**fourth** instance of one class: Stage 4 found it in `restart-origin.sh`, Stage 4 again in
the documented `docker run`, Stage 6 in `singleton-probe.mjs`. `scripts/usage-quota-browser-probe.mjs`
had the identical gap and had simply not been re-run since Phase 6.

Why it kept recurring: `deploymentArtifact.test.ts` asked `productionProblems` about only
**two** of the four launchers, because its two extractors read shell `export` lines and a
`sh -c` template literal — and these two build a JavaScript object and hand it to `spawn`,
which neither extractor can see.

Fixed in both places:

| Change | Effect |
|--------|--------|
| `DEPLOYMENT_TOPOLOGY: "single-instance"` in both `startServer` env objects | Both launchers boot |
| A third extractor (`envObjectWords`) and two more `it.each` rows | All **four** launchers are now handed to the gate itself |

The extractor takes only top-level pairs, drops an explicit `undefined` (the probes delete
those keys before spawning), and rewrites every non-literal value to `$RUNTIME` so the
existing body resolves it through `GATE_STANDIN` exactly as it does a shell `${X}` — the
question being asked is whether the *key* is set, not whether a throwaway path chosen at
run time is the right one. `GATE_STANDIN` gained absolute stand-ins for `STORAGE_LOCAL_ROOT`
and `ADMIN_STORE_DIR` for that reason; the schema default `.storage/local` is relative and
the gate rightly refuses it.

Severity **P3**. The product refused to start, loudly and with the reason — which is the
gate behaving exactly as designed. The cost is audit-time, and it is the expensive kind: a
gate-refused process answers nothing on every port, so a probe row that expects a refusal
can pass on a process that died. 16 tests in `deploymentArtifact.test.ts` (was 14).

## 4. The second one: the probe's caller isolation did nothing

With the server booting, the billing probe was **76/78**. Both failures were `429
RATE_LIMITED` where the check asserts `403 FORBIDDEN`:

- §19 "the endpoint refuses a non-owner, so the button state is not a lie in either direction"
- §21 "no purchase permission is derived from the foreign selector, on either endpoint"

The product was right — 429 grants nothing — but the *assertion* is not satisfiable by a
throttle: a rate-limited response cannot show that a non-owner was refused **for not owning**.

Root cause: `billingSessionRateLimiter` is 6 requests/60 s per client, and every request
this probe makes carries a distinct `X-Forwarded-For` from its own `nextIp()` helper, whose
docblock states that presenting each logical caller as its own client "stops the limiter
from turning a security assertion into a 429 that would read as a pass". It never did.
`clientIp()` reads `X-Forwarded-For` **only** when the request also presents
`TRUSTED_PROXY_SECRET` (`trustedClientAddress`) — documented, and correct: a forwarding
header anyone can send is a rate-limit key anyone can rotate. Without the secret every call
in the run keyed to the connection's peer address and shared one 6/min budget.

The probe now generates a per-run secret, passes it to the servers it spawns
(`TRUSTED_PROXY_SECRET`) and sends `x-pdfdadi-proxy-secret` on every request → **78/78**.

The corroborating detail is §15, the row that deliberately exhausts the limiter: it was
*passing* before the fix, on luck — it only requires the refusal to land after attempt 1,
and the trailing 60-second window happened to have room. With isolation working it now
reports `limited on attempt 7`, i.e. exactly `max = 6` admitted and the seventh refused.
Severity **P3**, probe-only: no product code changed and no product behaviour did.

## 5. What Stage 8 does NOT establish

- **Live Stripe.** Three rows are `ENVIRONMENT-LIMITED`: a successful Pro checkout URL, a
  successful portal URL, and a real configured price rendered as an amount. This probe signs
  its own events; real test-mode verification is `scripts/stripe-testmode-probe.mjs` and needs
  test credentials. Enabling live charges is an owner action and is outside this run's
  authorization.
- **Image CVE scan.** As above: no scanner, no container runtime.
- **TLS as it will be served.** The front is a self-signed terminator on a LAN address and
  every probe passes `--ignore-certificate-errors`. Certificate provisioning, cipher policy
  and HSTS preloading are the operator's, on the real hostname.
- **A penetration test.** These are targeted probes against known trust boundaries, driven by
  the same repository they test. They are not an adversarial review by someone who has not
  read the code.
- **Real customer documents**, by rule. Every fixture is synthetic.
- **Secret rotation.** No secret was requested, echoed, or written to any file in this
  directory. Which names the operator must configure is Stage 14's table, not a measurement.

## 6. Files changed by this stage

| File | Change |
|------|--------|
| `scripts/billing-probe.mjs` | `DEPLOYMENT_TOPOLOGY` and a per-run `TRUSTED_PROXY_SECRET` in the spawned environment; `x-pdfdadi-proxy-secret` on every request |
| `scripts/usage-quota-browser-probe.mjs` | `DEPLOYMENT_TOPOLOGY` in the spawned environment |
| `deploymentArtifact.test.ts` | `envObjectWords` extractor; all four launchers handed to `productionProblems`; absolute `STORAGE_LOCAL_ROOT`/`ADMIN_STORE_DIR` stand-ins |
| `scripts/upload-abuse-probe.mjs` | The L13 sampling race: a 1 s settle before the anonymous baseline is read (found in Stage 7, verified 32/32 twice here) |

## 7. Verified to bite

- Remove `DEPLOYMENT_TOPOLOGY` from `scripts/billing-probe.mjs` → the new row fails with the
  gate's own message (`1 failed | 15 passed`). Restored → 16/16.
- Before the proxy-secret fix, §19 and §21 failed on `429`; after it, 78/78 and §15 reports
  the exact budget. Both directions measured.
