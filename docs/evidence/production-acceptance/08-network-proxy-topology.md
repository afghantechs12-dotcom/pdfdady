# Stage 5 — supported network and proxy topology

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Measurements:** `08-network-proxy-topology.log` (this directory)
**No production host, DNS record or proxy was contacted.** Everything below is
either a relationship between two files in this tree or a measurement taken on
this machine.

## What Stage 5 has to answer

1. Who does the server think the caller is, and can the caller choose it?
2. What must a reverse proxy do, and what must it *not* be relied upon for?
3. What interface does the process bind?
4. Does anything trust a proxy's claim about host or protocol?

## 1. The defect: every limiter but one keyed on a header the caller writes — P1

Two functions answered "who is calling", with different rules:

| | reads `X-Forwarded-For` |
|---|---|
| `lib/server/uploadRateLimit.ts` → `trustedClientAddress()` | only after a sha256 + `timingSafeEqual` match of `x-pdfdadi-proxy-secret` against `TRUSTED_PROXY_SECRET` |
| `lib/server/rateLimit.ts` → `clientIp()` | **from anyone** — `"A trusted-proxy-aware extractor is future work (Milestone 2 hardening)"` |

`clientIp()` is the key for thirteen call sites — eight rate limiters and five
audit `ip` fields (`08-network-proxy-topology.log` §2):

| Keyed on it | Budget |
|---|---|
| `/api/admin/login` | 5 / min |
| `/api/admin/setup` | 10 / min |
| user login (`authHttp.ts`) | 10 / min |
| signup (`authHttp.ts`) | 10 / **hour** |
| billing session (`billingHttp.ts`) | 6 / min |
| `/api/csp-report` | 60 / min |
| `/api/analytics/events` | 120 / min |
| `/api/tools/[slug]`, `/api/jobs` | `TOOLS_RATE_LIMIT_PER_MIN`, default 20 / min |
| `ip` recorded on login, logout, signup, billing checkout and portal audit rows | — |

**The inversion is what makes it P1, not the bypass alone.** A browser sends no
`X-Forwarded-For`, so every honest caller shared the single `"unknown"` bucket,
while a caller who sent `X-Forwarded-For: 1`, `2`, `3` got a *fresh* bucket per
request. The limits were strictest on the traffic that was not attacking, and
absent for the traffic that was. Three of the audit rows recorded
`req.headers.get("x-forwarded-for")` directly, i.e. an attacker-chosen string in
the field an incident is reconstructed from.

**What the limit is protecting.** `crypto.scryptSync` at the shipped parameters
costs a **22.2 ms median** of blocked event loop per password attempt on this
machine (five runs, 21.8–22.4 ms; 24.2 ms measured earlier the same day — same
order). `lib/admin/passwords.ts` justifies that synchronous call by citing the
very rate limit that could be rotated away from, so the two defects compounded:
unbounded attempts against a verification that stalls every other request.

**The third source the prior audit lacked.** `docs/FINAL_PRELAUNCH_AUDIT.md:2483`
had accepted a dilemma — a client-address key is either spoofable "or would
collapse every anonymous caller into one global bucket, i.e. an easy denial of
service". `ingress/guard.mjs` is the one place in the deployment that sees a
socket, and production **refuses to serve** when it is not installed
(`assertInstalled()` plus `src/infrastructure/config/startupGate.ts`), so the
connection's peer address is a third source: unspoofable *and* per-caller.

**Fixed at the root, not per call site.** One shared function and one boundary
stamp, not thirteen patches:

- `ingress/guard.mjs` deletes any client-sent `x-pdfdadi-peer` and stamps
  `req.socket.remoteAddress` into it, before Next sees the request.
- `clientIp()` now resolves, in order: a **verified** proxy's `X-Forwarded-For`
  first hop (or `X-Real-IP`) → the stamped peer → the literal `"unknown"`.
- The three auth routes record `ip: clientIp(req)` instead of the raw header.
- `uploadRateLimit.ts` keeps its behaviour exactly; the trust rule moved *down*
  into `rateLimit.ts` and is re-exported, because the dependency already runs
  that way (`uploadRateLimit` imports `RateLimiter`) and importing back up would
  have risked a TDZ crash on its module-scope `new RateLimiter(...)`.

The ingress→handler link is verified **statically**: Next 16.3.4's
`NextRequestAdapter.fromNodeNextRequest` builds the handler's `Request` with
`fromNodeOutgoingHttpHeaders(request.headers)` at adapt time — a header the
wrapper mutated is therefore in it (Next's own `// ip` field is commented out,
which is why a header is the channel). `node_modules` was deliberately not
source-pinned by a test. **Runtime confirmation is deferred to Stage 6**, because
the accepted cold artifact (`BUILD_ID 98appVCcbyMxzlhk26zya`) predates these
route changes and would exercise stale code; the surrogate needs a rebuild
anyway for its https origin.

### Verified to bite (`§3` of the log) — each removal restored afterwards

| Guard removed | Result |
|---|---|
| M1 `clientIp` trusts `X-Forwarded-For` again | 3 failed / 9 |
| M2 the guard does not stamp the peer | 2 failed / 13 |
| M3 the stamp keeps a client-sent copy (`delete` removed) | 1 failed / 13 |
| M4 the audit surrogate stops exporting `STORAGE_LOCAL_ROOT` | 1 failed / 13 |
| M5 the guide's cap for one streaming path deleted | 1 failed / 13 |
| M6 the guide's cap broadened to all of `/api/` | 1 failed / 13 |

M3 is the one that needed a second thought: over TCP the assignment that follows
overwrites whatever the client sent, so the `delete` looks inert and the suite
stayed green without it. It matters only when `remoteAddress` is undefined — a
**Unix domain socket** — so the test that makes it bite connects over one
(`ingress/guard.test.ts`, "leaves no forged peer behind when the connection has
no address"). Without that test the security half of the stamp was unguarded.

## 2. Behind a proxy the key gets coarser, not weaker

Every request then arrives from the proxy's address, so with no
`TRUSTED_PROXY_SECRET` configured all callers share one key. Unspoofable, but one
caller can spend another's budget — 5 admin logins a minute for the whole
internet. Previously invisible; now the server warns **once per process** (not
per request) when `X-Forwarded-For` arrives with no secret configured, naming the
variable and never the address. The same collapse applies to a Unix-socket-fronted
deployment; the supported topology is TCP.

## 3. Body limits are the application's own; the proxy sample is defence in depth

Unchanged from Phase 6 and restated here because it is the topology question an
operator asks: `ingress/guard.mjs` classifies every request before Next sees it —
class A `0` bytes, class B 2 MiB, and the five streaming upload paths keep their
own bounded readers — so the 28 × 100 MiB anonymous burst offers **15.75 MiB of
2800** with no measured RSS growth. No reverse proxy is required for that bound.

What *was* unguarded is the sample `nginx` config in `SERVER_SETUP.md`: it raises
`client_max_body_size` on the streaming paths and asked the reader, in prose, to
keep that list in step with `STREAMING_ROUTE_PATTERNS`. `ingress/policy.test.ts`
pins those patterns against the `proxy.ts` matcher; nothing pinned the
**documented** list against either, so a sixth streaming route would pass every
test and then 413 at the proxy of anyone who runs one. Now pinned in both
directions (M5, M6) — every streaming path has a cap, and no cap reaches a class
B path. Severity **P3**, fixed with its guard.

## 4. Bind contract as shipped

`PORT=3000` in both the Dockerfile and compose; `HOSTNAME` is set nowhere, so
Next's standalone server binds `0.0.0.0`. That is correct for a container that
publishes a port and relies on the network for isolation. A **host** install
behind a proxy should set `HOSTNAME=127.0.0.1` so the origin is not reachable
except through the proxy — documented in `.env.example` under "Set by the
platform", and not something the boot gate can check, since a value it cannot see
is not a value it can refuse.

## 5. Nothing trusts a forwarded host or protocol

`grep` across `app/`, `src/`, `lib/`, `ingress/` for `x-forwarded-proto`,
`x-forwarded-host` and `headers.get("host")` returns **only** matches inside
`workspaceCsrfProxyOrigin.test.ts`, which asserts those headers are ignored
(§4 of the log). Absolute URLs — canonical/OG tags, signed download and multipart
URLs — come from `NEXT_PUBLIC_SITE_URL`, which is baked at build time, so no
`Host` header can redirect a signed link or poison a canonical tag.

## 6. What Stage 5 does NOT establish

- **That the stamped header reaches a route handler at runtime.** Static only,
  for the reason above. Stage 6 must confirm it end to end: rotating
  `X-Forwarded-For` against `/api/admin/login` is refused at the 6th attempt, and
  the audit row records the peer rather than the sent header.
- **That the sample proxy config works.** No nginx or Caddy on this machine; the
  config is asserted against the code's path set, never executed.
- **TLS.** The Stage 6 surrogate fronts the origin with `scripts/tls-front.mjs`,
  a local self-signed helper, not a production TLS configuration.
- **Multi-instance behaviour.** Out of scope by declaration:
  `DEPLOYMENT_TOPOLOGY=single-instance` is required and is the only accepted
  value, and the instance lease refuses a second process.

## Files changed by this stage

| File | Change |
|------|--------|
| `lib/server/rateLimit.ts` | The trust rule moved in; `PEER_ADDR_HEADER`; `clientIp` rewritten to the three-source order; once-per-process warning |
| `lib/server/uploadRateLimit.ts` | Moved code removed and re-exported, so no importer changes |
| `ingress/guard.mjs` | `stampPeer` — delete any client copy, stamp `req.socket.remoteAddress` |
| `app/api/auth/{login,signup,logout}/route.ts` | Audit `ip` is the resolved address, not a header |
| `ingress/guard.test.ts` | TCP stamp + overwrite, the name pinned against the app's constant, and the UDS test that makes the `delete` bite |
| `lib/server/rateLimit.test.ts` | Four unvouched header shapes ignored; N spoofs spend one bucket; a verified proxy's hop preferred; warns once and never logs the address; `"unknown"` when nothing identifies the caller |
| `deploymentArtifact.test.ts` | The audit surrogate's environment fed to the real gate; the documented nginx caps pinned against `STREAMING_ROUTE_PATTERNS` |
| Six route test helpers | Repointed from `x-forwarded-for` to `x-pdfdadi-peer` where the intent was "a distinct client per test" |
| `scripts/restart-origin.sh` | Exports `STORAGE_LOCAL_ROOT` (Stage 4's gate change had made the surrogate unbootable) |
| `SERVER_SETUP.md`, `.env.example` | The forwarding-header claim corrected to the real three-source rule, with the proxy consequence |
