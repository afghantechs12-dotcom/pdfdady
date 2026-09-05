# Deploy and rollback — the procedure this build actually supports

Written from the shipped artifacts (`Dockerfile`, `docker-compose.yml`,
`prisma/migrations`, `scripts/restart-origin.sh`), not from a template. Where the
repository does not record a decision, the row says so instead of inventing one.

## What the entrypoint does

`CMD` is `prisma migrate deploy … && exec node ingress/server.mjs`
(Dockerfile:102 — it read `exec node server.js` at Dockerfile:88 when this runbook
was written, and the ingress closeout changed both the entry and the line number):
migrations run **before** the server serves, and a migration failure exits
non-zero rather than leaving a container up and 500ing. The entry matters for
rollback: `ingress/server.mjs` installs the request-body guard and holds the
single-instance lease, so an image that starts the generated `server.js` directly
now exits 1 instead of serving unguarded. `migrate deploy` is a
no-op when there is nothing pending, so a plain restart is safe.

There is **no down-migration**. Prisma applies forward only, and this repository
has no reverse SQL for any migration in `prisma/migrations`. That single fact
shapes everything below: rolling the image back does not roll the schema back.

## Before every deploy

1. Record the artifact you are leaving: `git rev-parse HEAD` and the image digest
   (`docker image inspect pdfdadi:latest --format '{{index .RepoDigests 0}}{{.Id}}'`).
   `pdfdadi:latest` is a **mutable tag** and the next build overwrites it — the
   digest is the only way back. Nothing in the repository stores it.
   `LAUNCH DECISION REQUIRED`: where the previous digest/SHA is kept, and how many
   are retained.
2. Snapshot the database **while it is open**, using the procedure proven in
   `migration-restore-drill.log` (`node:sqlite`'s online `backup()`; 950272 bytes /
   232 pages; restored to a byte-for-byte content match). A file copy of an open
   SQLite database in WAL mode is not a backup.
3. Snapshot `pdfdadi-storage` if the release touches stored objects. The database
   references keys inside it; restoring one without the other produces documents
   whose bytes are gone.
4. Note whether the release contains a new directory under `prisma/migrations`.
   This is the question the rollback path turns on, and it is answerable with
   `git diff --stat <previous>..HEAD -- prisma/migrations`.

## Deploy

    docker compose up -d --build          # entrypoint migrates, then serves

Verify, in this order:

1. `docker compose ps` — the container is `healthy`, not merely `running`. The
   HEALTHCHECK calls `/api/health` every 30 s with a 20 s start period.
2. `curl -fsS http://127.0.0.1:3000/api/health` → `{"ok":true,"status":"up"}`.
3. `curl -sS http://127.0.0.1:3000/api/health/ready` → **200** `"ready"`.
   A 503 with `"toolchain":false` means a required binary is missing from the
   image; a 503 with `"database":false` means migrations ran but the pool cannot
   read. Readiness caches its dependency probe for 30 s (`DEP_CACHE_MS`), so a
   dependency fixed seconds ago can still read false — wait it out rather than
   redeploying on top of a stale answer.
4. One real workflow, not just the health endpoints: upload → run a server tool →
   download the result. Health is honest about dependencies and says nothing about
   whether a job completes.

## Rollback

**Case A — the release added no migration.** Roll the image back on its own:

    docker compose down                   # NOT `down -v`: -v destroys the volumes
    docker compose up -d --no-build       # with image: pinned to the recorded digest

The database is untouched; nothing is lost. Re-verify with the four steps above.

**Case B — the release added a migration.** The old code will meet the new schema,
and the failure mode is silent-wrong rather than loud: Prisma queries columns that
no longer mean what they did. Roll the image back **and** restore the pre-deploy
snapshot from step 2:

    docker compose down
    # restore the snapshot over /app/data/db/pdfdadi.db in the pdfdadi-db volume
    docker compose up -d --no-build       # previous digest

**Everything written between the deploy and the restore is lost** — accounts,
documents, versions, jobs. That is the cost of Case B and the reason the decision
has to be made in minutes, not hours. If the release is functional but imperfect,
rolling *forward* with a fix is usually cheaper than Case B.

`LAUNCH DECISION REQUIRED`: who authorizes a Case B restore, and the acceptable
data-loss window.

## What was and was not exercised on the audit host

- [deploymentArtifact.test.ts](deploymentArtifact.test.ts) asserts the standalone output carries the migration
  toolchain the entrypoint needs, so `migrate deploy` cannot be missing from the
  image (this is what mutation `mutation-C-deployment.md` breaks).
- The migrate-and-restore drill ran for real: `migration-restore-drill.log`.
- The **container** deploy/rollback path is `NOT EXERCISED` on this host —
  no Docker daemon is available (`ENVIRONMENTAL`, recorded in `audit-static.log`).
  The equivalent code-level path (previous commit → rebuild → boot → health →
  workflow) is what the audit exercised, through `scripts/restart-origin.sh`.
