# PDFDadi — release candidate manifest (Stage 1)

Captured: 2026-09-05T12:54:38Z (UTC)

## Identity

| | |
| --- | --- |
| Source commit | `3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b` (`3e4ac8b`) |
| Acceptance branch | `production-acceptance`, cut from `ingress-memory-safety-closeout` at that commit |
| `main` | untouched; merge-base `5a4adca7c8550a23d2fbc39f521a33a3f0adf523`, 125 commits behind the branch tip |
| Git remotes | none configured — nothing has been pushed anywhere |
| Cold build artifact | `.next/BUILD_ID` = `98appVCcbyMxzlhk26zya` (the accepted artifact) |
| `package-lock.json` | sha256 `43558cef02ddf3ed8a579b82a995bb8e080e29c26da50ef2a91da1119a9fd039` |

## Toolchain

| | Built/verified on | Deployment target |
| --- | --- | --- |
| Node | v26.7.0 (this machine) | `node:24-bookworm-slim`; `package.json` declares `engines.node >= 24` |
| npm | 11.19.0 | `npm ci` in the `deps` stage |
| Next.js | 16.3.4 | `output: "standalone"` |
| Prisma | CLI 6.19.3, client 6.19.3 | `migrate deploy` at container start |

## Build

```
npm run build   →  prisma generate && node scripts/next-build.js
npm start       →  node ingress/server.mjs        # the ONLY supported entry point
```

`node server.js` (the generated standalone entry) exits 1 in production:
`assertIngressInstalled()` refuses to serve without the ingress guard installed.
`scripts/next-build.js` pins `VIPS_CONCURRENCY=1`. `next build` is exempt from the
production configuration gate via `NEXT_PHASE=phase-production-build`, so CI
compiles without any production secret.

## Database

`prisma/schema.prisma` declares `provider = "sqlite"`. 24 migrations, applied with
`prisma migrate deploy` — never `migrate dev`, never `migrate reset`:

```
 1 20260727091322_init                          13 20260803010908_add_search_index
 2 20260727165301_add_user_password              14 20260803111811_add_document_metadata_bookmarks_outlines_attachments
 3 20260801150000_add_workspaces                 15 20260803144104_add_comments_and_document_permissions
 4 20260801170000_add_organization_membership_lookup_index
                                                 16 20260803144651_add_comment_thread_page_anchor_index
 5 20260801185338_add_projects_and_folders       17 20260803233259_add_statistics_and_comparisons
 6 20260801191609_add_document_records           18 20260804000000_add_user_name
 7 20260802145047_add_workspace_sessions         19 20260824010000_add_processing_job_fields
 8 20260802153439_add_document_ingestions        20 20260824120000_add_usage_metering
 9 20260802170336_add_autosave_drafts            21 20260825010000_add_usage_settlements
10 20260802175053_autosave_snapshot_metadata     22 20260825120000_add_billing_subscriptions
11 20260802190000_add_document_versions          23 20260902100000_add_workspace_save_intents
12 20260802234143_add_tags_and_smart_collections 24 20260905090000_add_instance_lease
```

Latest migration: `20260905090000_add_instance_lease` — the single-instance lease
table. Rollback of `20260902100000_add_workspace_save_intents` is asymmetric and
documented in the save-intent closeout: forward is a migration, backward is not.

## Required external binaries

Readiness (`/api/health/ready`) requires all seven, and answers 503 if any is
missing: `soffice` (LibreOffice), `gs` (Ghostscript), `qpdf`, `pdftoppm` and
`pdfinfo` (poppler-utils), `tesseract`, `ocrmypdf`. The Dockerfile installs a
package for each, plus `tesseract-ocr-{eng,deu,fra,spa}`, `fonts-liberation`,
`fonts-dejavu`, `fonts-noto-core` and `python3`.

## Supported deployment topology

Exactly one serving instance, declared by `DEPLOYMENT_TOPOLOGY=single-instance`
(the only accepted value) and enforced at runtime by a database lease:
`instance_leases['app']`, holder `<host>:<pid>:<uuid>`, 3 s heartbeat, 10 s TTL,
2 s clock grace. A second instance answers 503 and stands by rather than exiting.
Measured previously: 12.1 s unattended SIGKILL failover, 0.43 s clean release.

Two independent reasons, both still true: upload rate limiting is three in-memory
Maps in one process (`lib/server/uploadRateLimit.ts`, 120/20/240 per minute), and
SQLite supports one writable deployment per file
(`docs/adr/ADR-M7-009-sqlite-operations.md`). Scaling out is PostgreSQL plus a
shared rate-limit store plus this variable, in that order.

## Persistent data paths

| Path (container) | Holds | Compose volume |
| --- | --- | --- |
| `/app/data/db` | the SQLite database (`DATABASE_URL`) | `pdfdadi-db` |
| `/app/data/storage` | uploaded and generated documents (`STORAGE_LOCAL_ROOT`) | `pdfdadi-storage` |
| `/app/data/admin` | admin store (`data/admin/store.json`) | `pdfdadi-data` |
| `/tmp` | per-job scratch | `tmpfs` |

Losing any of the first three loses production data. `/tmp` is disposable by design.

## Required environment variable names

Production refuses to boot without: `DATABASE_URL`, `ADMIN_SECRET`,
`NEXT_PUBLIC_SITE_URL`, `DEPLOYMENT_TOPOLOGY=single-instance`.
`NEXT_PUBLIC_SITE_URL` is also needed at **build** time.
Everything else is optional and disables a feature rather than blocking startup.
The full classified contract, and the secret names the owner must place in a secret
manager, are in `03-environment-contract.md`.

## Feature flags

| Flag | Default | Effect |
| --- | --- | --- |
| `PROCESSING_PIPELINE` | unset → database flag (disabled) | unified pipeline for the pilot tool `compress-pdf` only; env beats the database, because a flag row is no help when the database is what you are rolling back from |
| `USAGE_LIMIT_MODE` | `observe` | `observe` records consumption without refusing work; `enforce` turns plan ceilings into limits; `off` disables |
| Billing | off unless key + webhook secret + a price are all set | no partial mode |
| Storage | local disk unless all four `R2_*` are set | half-configured R2 is refused at boot |
| Queue | in-memory unless `REDIS_URL` is set | a shared queue does not make the app multi-instance |

## Known limitations carried into acceptance

ENVIRONMENTAL on this host — not product defects, and not fixable here:

| | |
| --- | --- |
| No container runtime | docker, podman, nerdctl, finch, colima, lima, buildah, kubectl all absent → Stage 3 is static validation only |
| No image scanner | trivy, grype, syft, docker-scout absent |
| `soffice` absent | `pdf-to-word` and `html-to-pdf` cannot run here, and `/api/health/ready` correctly answers 503 `toolchain:false` on this machine |
| No staging target, no hosting credentials, no monitoring provider, no remote | Stages 6–10 run against a local production-mode surrogate; monitoring is provider-neutral templates |

Carried from the final prelaunch audit: 12 `MANUAL REVIEW REQUIRED` rows (A3, A4,
E5, E6, G6, I4, J3, K3, L3, N2, Q4, R3 — I4 closed in this stage by
`engines.node`), 4 `NOT EXERCISED`, 2 `ENVIRONMENTAL`, and 14 owner decisions.
Every one of them is reconciled in the Stage 13 decision register.
