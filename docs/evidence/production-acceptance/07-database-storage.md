# Stage 4 — persistent database and storage

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Measurements:** `07-database-storage.log` (this directory), `06-migration-restore-drill.log`
**Everything below ran against throwaway paths under `/tmp`.** No real database, no
real storage root, and not the repository's own `prisma/dev.db`.

## What Stage 4 has to answer

Four questions, in the order an operator meets them:

1. Does the container's own migrate step work on an empty volume, and is a
   redeploy a no-op rather than a second migration?
2. Is the data actually persistent — i.e. do the paths the app writes to land
   inside the mounts, and what happens when they do not?
3. Can the database be backed up while it is open, and restored?
4. Does the storage adapter behave on a freshly attached, empty volume?

## 1. The container migrate step

The image's `CMD` is `node node_modules/prisma/build/index.js migrate deploy
--schema prisma/schema.prisma && exec node ingress/server.mjs`. That exact
command, not a paraphrase of it:

| Run | Result | Exit |
|-----|--------|------|
| Empty database | `All migrations have been successfully applied.` — 24 rows in `_prisma_migrations`, 43 tables | 0 |
| Immediately again | `No pending migrations to apply.` | 0 |

`integrity_check` = `ok`; the file is 234 × 4096 = 958 464 bytes.

`migrate deploy` — never `migrate dev`, never `migrate reset` — is what the
container runs, so a deployment cannot generate a migration or drop a database.
The hardcoded path to the Prisma CLI inside `node_modules` is deliberate
(`node_modules/.bin` is not copied into the runtime image) and is now pinned
against the package's own `bin` field by `deploymentArtifact.test.ts`, so a
Prisma bump that moves that file fails in the suite instead of at container boot.

## 2. `journal_mode` is `delete`, not WAL

Measured on the database the migrate step produces: **`journal_mode = delete`**,
the SQLite default. Nothing in the deployment sets WAL.

Two consequences, both operational:

- A **hot file copy is not a backup**, and not because of WAL — in rollback-journal
  mode a copy taken mid-transaction can capture a database whose journal is not
  copied with it. The correct procedure is the online backup API, which is what
  the drill exercises and what the rollback runbook prescribes. That runbook's
  sentence attributed the hazard specifically to WAL mode; it is corrected here
  and in the runbook, because "we are not on WAL" must not read as permission to
  `cp` an open database.
- Writers block readers for the duration of a write. That is not a new fact — the
  build is single-writer SQLite by declaration (`DEPLOYMENT_TOPOLOGY=single-instance`,
  ADR-M7-009) — but it is the reason the topology gate exists, and it is worth
  knowing before someone attributes a slow request to the application layer.

Foreign-key enforcement is a **per-connection** pragma in SQLite, not a property
of the file, so it is not measurable from a backup copy; Prisma sets it on its
own connections.

## 3. Backup and restore

`node scripts/migration-restore-drill.mjs` → **PASS 16/16, exit 0**
(`06-migration-restore-drill.log`).

What the drill establishes, on throwaway copies:

- The 23 migrations before the head migration build a schema that does **not**
  contain the head migration's table, and applying the head migration adds it.
  (This row was silently vacuous until this stage: the script derived the head
  migration dynamically but compared against a hardcoded table name from an
  earlier phase, so the "exists afterwards" row passed for the wrong reason and
  the "absent before" row failed. Both now derive the table from the head
  migration's own SQL — see the fix in this branch.)
- `migrate deploy` on an empty database reaches head with nothing pending and no
  drift.
- The backup is taken with `node:sqlite`'s online `backup()` **while the database
  is open**, then real rows are destroyed, then the restore reproduces the
  destroyed content byte-for-byte (`sha256` match over the content tables).
- The restored file is at migration **head**, not at the schema it was baselined
  from.

## 4. Local object storage

`LocalFileStorage` (the default provider; R2 is optional and unset here), against
a throwaway root:

| Check | Result |
|-------|--------|
| `put` then `get` round trip | PASS, 38 bytes |
| Nested key creates its directories | PASS |
| File mode | `0644` |
| Traversal key (`../../escape`) | Refused — `Invalid storage key (escapes root)` |
| `delete` removes the file | PASS |
| **Root directory absent** (freshly attached empty volume) | PASS — the adapter creates it |

## 5. The defect this stage found: a storage root inside the image layer

`LocalFileStorage` resolves its root with `path.resolve()`, so the default
`.storage/local` — correct for `next dev` — resolves against the **working
directory**. In the container that is `/app`, i.e. the image's writable layer:
every uploaded and generated document would be deleted by the next deploy.

The production gate already refused exactly this shape for the database ("a
relative path would silently put the live database inside the container's writable
layer and delete it on the next deploy") and for half-configured R2 ("uploads
would land on an ephemeral container disk and vanish on redeploy"). The third
path — local storage with a relative root — had **no guard**. `docker-compose.yml`
sets an absolute root onto a volume, so this repository's own deployment was
safe; a deployment that is not that compose file (raw `docker run`, a PaaS,
systemd) got no such help.

Fixed in this branch, in the gate rather than in a document:
`productionProblems` now refuses a relative **or empty** `STORAGE_LOCAL_ROOT`
when object storage is local, and says where to point it. An empty value is the
same branch on purpose: it resolves to the working directory itself, which would
write objects among the application files.

Verified to bite: with the new branch removed, the two tests that cover it fail;
restored, the suite is green. Severity **P2** — silent total loss of stored
documents on redeploy, but only for a non-compose deployment, and it refuses to
boot rather than losing data now that the guard exists.

## 6. A second, smaller one: the documented `docker run` could not boot

`SERVER_SETUP.md` offers a compose-free `docker run` and says every variable in
it is required. It omitted `DEPLOYMENT_TOPOLOGY`, which the gate has required
since Phase 6 — so the command as printed exited 1 before serving a request. The
flag is added, and `deploymentArtifact.test.ts` now feeds both deployment
paths — the compose `environment:` block and that documented command — to
`productionProblems` itself. The old assertion listed three variable names by
hand, which is how it stayed green while the gate grew two more requirements.
Severity **P3** (documentation), fixed with its guard.

## 7. What Stage 4 does NOT establish

- **That the mounts are mounted.** Prisma *creates* a missing directory: an
  absolute `DATABASE_URL` with a typo in it (`/app/data/database/…` where the
  volume is `/app/data/db`) applies all 24 migrations to a brand-new empty
  database, exits 0, and serves. The same is true of the storage root. Nothing in
  the process can distinguish that from a first deploy, and the gate can only
  check the *shape* of a path, not whether it is a mount point.
  → Verification belongs to the operator, once, at first boot; it is a row in the
  go-live checklist (Stage 14), not something code can assert:
  `docker compose exec app ls -l /app/data/db /app/data/storage` and
  `docker volume inspect pdfdadi-db` after the first upload.
- **That readiness notices a broken volume.** `/api/health/ready`'s `dataDir`
  check is `fs.access(path.dirname(STORE_PATH))` — the presence of
  `/app/data/admin` only. It does not test writability, and it says nothing about
  `/app/data/db` or the storage root. A read-only or unmounted storage volume
  leaves readiness reporting 200. This is manual row **L3**; changing it changes
  when a load balancer drains an instance, so it is a Stage 13 decision with a
  recommendation, not a silent edit made here.
- **Container execution.** No container runtime on this machine:
  `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME` (Stage 3,
  `05-container-static.md`). Everything above ran the container's *commands* on
  the host, against the same repository the image is built from.
- **Restore of the storage volume.** The drill covers the database. Object
  storage has no drill: the documents are immutable blobs whose keys the database
  references, so the procedure is a volume snapshot taken with the database
  snapshot, and restoring one without the other yields records whose bytes are
  gone. That pairing is stated in the rollback runbook; it is not exercised here.

## Files changed by this stage

| File | Change |
|------|--------|
| `src/infrastructure/config/env.ts` | The gate refuses a relative/empty `STORAGE_LOCAL_ROOT` when storage is local |
| `src/infrastructure/config/env.test.ts` | Two cases for it; `STORAGE_LOCAL_ROOT` added to the cleared-and-restored key set and to the valid-production fixture |
| `deploymentArtifact.test.ts` | Compose *and* the documented `docker run` are handed to `productionProblems` instead of a hand-written list of names |
| `deploymentTopology.test.ts`, `instrumentation.test.ts`, `workspaceCsrfProxyOrigin.test.ts` | Same fixture addition — a valid production environment now says where objects land |
| `SERVER_SETUP.md` | `STORAGE_LOCAL_ROOT` in the required table; `DEPLOYMENT_TOPOLOGY` in the `docker run`; the sample refusal shows five problems |
| `.env.example` | The storage root is documented as required-when-local and absolute |
| `scripts/migration-restore-drill.mjs` | Head table derived from the head migration's SQL; one vacuous row and one stale label removed |
| `docs/evidence/final-prelaunch/rollback-runbook.md` | The hot-copy hazard is not specific to WAL |
