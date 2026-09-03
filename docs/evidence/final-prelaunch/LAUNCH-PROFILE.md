# Group C — the launch profile

Everything here is read out of the repository, with the file that decides it. Where
the code cannot decide, the row says **`LAUNCH DECISION REQUIRED`** and nothing is
invented — a guess in this table would be the most expensive kind of audit error,
because it reads like a fact.

## Commercial shape

| Question | What the code says | Where |
|---|---|---|
| Plans | three: `free` (`available: true`), `pro` (`available: false`), `business` (`available: false`) | `data/pricing.ts` |
| Can money be taken today? | **Only if the deployment sets all three of** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`. Any other count → `billing.enabled = false`, checkout and portal answer `503 BILLING_NOT_CONFIGURED`, and a boot warning says so | `env.ts:161` `buildBillingConfig`, `configWarnings` |
| What a visitor is told when it is not configured | Pro reads `"Not yet available"` and its CTA points at contact, not at a disabled Subscribe button. Resolved per request by `/api/billing/summary` → `ProConfigured` / `ProPriceLabel` / `ProUpgradeAction` | `data/pricing.ts` docstring |
| Business | non-purchasable **by domain law**, not by configuration: `BillingPriceMap` has no `business` slot, and there is deliberately no `STRIPE_PRICE_BUSINESS` variable | `src/domain/billing/subscription.ts`, `env.ts:121` |
| Does the free tier stay free? | the copy says `"$0 today"`, deliberately, because the file cannot know | **`LAUNCH DECISION REQUIRED`** |
| Are Stripe keys going to be set at launch? | nothing in the repository says | **`LAUNCH DECISION REQUIRED`** — a free-only launch and a paid launch are both fully supported; the difference is three environment variables |

So the code supports **either** launch. What it refuses to do is show a price it
cannot charge, which is the property mutation M tests.

## Accounts

| Question | What the code says |
|---|---|
| Registration | **open and public.** `POST /api/auth/signup` provisions on the spot; no invite code, no allowlist, no approval step exists anywhere in the route or `AuthService` |
| `/api/auth/register` | a thin alias that re-exports the signup handler, so a bookmark cannot reach a second, subtly different signup path |
| Email verification | **none.** No `emailVerified` column, no verification token, no send. An account is usable the moment it is created |
| Password recovery | **none.** No reset token, no forgot-password route, no page. A forgotten password today means a lost account, and the only recovery is an operator editing the database |
| Rate limits | signup 10/hour, login 10/minute (`authHttp.ts:112`) |
| Session lifetime | 30 days (`AuthService.ts:21`) |

The two absences are the launch-relevant ones and they are **not** defects of
implementation — nothing half-built is being shipped. They are scope: a product
with open public registration, no verification and no recovery will generate
support load in exactly one shape (locked-out users, mailed to a human).
**`LAUNCH DECISION REQUIRED`**: launch without recovery and absorb that, or hold
launch for it. The audit's job is to make sure nobody discovers it in week two.

## Platform and data

| Question | What the code says | Where |
|---|---|---|
| Artifact | container. `Dockerfile` builds standalone and copies `.next/static` explicitly; a hand-rolled `.next/standalone` copy is the documented silent failure | §25 |
| Database | **SQLite, enforced at boot.** `DATABASE_URL` must start `file:` and must be absolute. A `postgresql://` URL is refused with an explanation, because Prisma would accept it at startup and fail every query afterwards | `env.ts:207`, `productionProblems` |
| Moving to Postgres | possible, but it means changing `schema.prisma`'s provider, this gate, **and regenerating the migration history** — SQLite migration SQL is not portable. Not a configuration change | `env.ts` docstring |
| Persistence | absolute path on a persistent volume, e.g. `file:/app/data/db/pdfdadi.db`. A relative path is refused by name: it would resolve into the container's writable layer and be deleted by the next deploy | `productionProblems` |
| Object storage | `r2` if all four `R2_*` variables are set, else `local`. **Half-configured is refused at boot** rather than silently selecting local disk and losing uploads on redeploy | `buildStorageConfig`, `productionProblems` |
| Queue | `redis` if `REDIS_URL` is set, else in-memory. Neither blocks startup | `buildQueueConfig` |
| Secrets | `ADMIN_SECRET` required, refused if absent, if it equals the public dev fallback, or if under 16 characters. It signs admin sessions **and** local download URLs, so absent means both are forgeable | `productionProblems` |
| Public origin | `NEXT_PUBLIC_SITE_URL` must be absolute http(s) and non-loopback: signed download and multipart URLs are built from it | `productionProblems` |
| Domain | `data/admin/store.json` carries `https://pdfdadi.com` | that is the configured intent; whether DNS/TLS is provisioned is **`LAUNCH DECISION REQUIRED`** |
| Markets / languages / currency | one language, one currency implied by `$`; nothing in the repository states a target market | **`LAUNCH DECISION REQUIRED`** |

## Observability, retention, support

| Question | What the code says | Where |
|---|---|---|
| Analytics | **first-party only.** `ConsoleAnalytics` behind an `IAnalytics` port; usage lands in the app's own tables via `UsageRepository`. No third-party script, no cookie banner obligation created by it | `container.ts:371` |
| Error monitoring | **none.** `IErrorReporter` is wired to `ConsoleErrorReporter` — errors go to stdout and nowhere else. The port exists so Sentry swaps in without touching call sites, but no deployment file configures one | `container.ts:374` |
| Log destination | container stdout | **`LAUNCH DECISION REQUIRED`** — nothing in the repository says where stdout is collected or how long it is kept, and the answer to "was there an error last Tuesday" depends entirely on it |
| Backups | `node:sqlite`'s online `backup()` — proven at 950272 bytes / 232 pages while the database was open, restored to a byte-for-byte content match | §15 |
| Backup schedule / off-host copy | nothing in the repository schedules one | **`LAUNCH DECISION REQUIRED`** — the *procedure* is proven, the *policy* does not exist |
| Tool output retention | 1 hour TTL, sweep every 15 minutes, inputs purged with outputs | `PdfToolWorkerHandler.ts:64,67` |
| Save intentions | pruned at a **30-day** horizon by the same recurring sweep. Resolves the previously unbounded `workspace_save_intents` table; the ceiling is written at the constant — replaying a key older than the horizon saves the payload a second time instead of answering with the first document | `PdfToolWorkerHandler.ts:81,562` |
| Support channel | one: `mailto:hello@pdfdadi.com` on `/contact`. The form no longer claims to deliver anything it discards (P3, `f55ffca`) | `components/contact/ContactForm.tsx:50` |
| Is that inbox monitored? | nothing in the repository says | **`LAUNCH DECISION REQUIRED`** — and it is the *only* channel, which makes it the whole support plan |

## The seven decisions this audit cannot make

1. Free-only launch, or set the three Stripe variables.
2. Whether the free tier stays free once paid plans exist.
3. Launch without password recovery, or hold for it.
4. Domain, DNS and TLS provisioning for `pdfdadi.com`.
5. Target markets / languages / currency.
6. Where container stdout is collected and for how long.
7. Backup schedule, off-host destination, and who is on the hook for it.

None of the seven is a code defect and none blocks a build. Each one is a
sentence someone has to write down before traffic arrives, and this document
exists so that no one has to reverse-engineer the list from the source at 2am.
