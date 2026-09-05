# PDFDadi — container artifact validation (Stage 3)

Captured: 2026-09-05T13:02:00Z (UTC) — branch `production-acceptance`, base `3e4ac8b`

## CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME

```
docker     ABSENT      podman     ABSENT      nerdctl    ABSENT
finch      ABSENT      colima     ABSENT      lima       ABSENT
limactl    ABSENT      buildah    ABSENT      kubectl    ABSENT
skaffold   ABSENT
```

Image scanners, also absent: `trivy`, `grype`, `syft`, `docker-scout`, `dockle`,
`hadolint`.

No image was built, no container was started, and no line below should be read as
evidence that either works. What follows is the relationship between files in this
tree, which is what can be checked without a daemon.

## What was validated, and how

| Property | Verdict | Basis |
| --- | --- | --- |
| Every `COPY` source exists in the tree or an earlier stage | PASS | `deploymentArtifact.test.ts` resolves each `COPY` source, including `--from=<stage>` paths, onto a repository path — the check that would have caught `COPY --from=builder /app/public` on a repo with no `public/` |
| The migration toolchain the standalone trace omits is copied | PASS | `node_modules/prisma`, `node_modules/@prisma/engines`, `prisma/` all copied; `prisma/migrations` exists with 24 migrations |
| The CMD's hardcoded CLI path is where the package puts it | PASS (newly pinned) | `prisma`'s own `bin.prisma` is `build/index.js`, which is what the CMD invokes. `node_modules/.bin` is not copied into the image, so the CMD must name the file; a version bump that moves it would leave the build green and the container dead at boot |
| Migrations run before serving, and only on success | PASS | `sh -c "… migrate deploy … && exec node ingress/server.mjs"` — `&&`, and `migrate deploy` precedes the exec |
| The image starts through the ingress guard, and contains it | PASS | `COPY … ingress ./ingress` plus `exec node ingress/server.mjs`; `npm start` is the same entry point. `server.js` is not reachable: `assertIngressInstalled()` exits 1 in production |
| The public origin reaches the build, not only the runtime | PASS (fixed in Stage 2) | `ARG NEXT_PUBLIC_SITE_URL` in the builder stage; compose passes the same value it later sets at runtime |
| Runs as a non-root user | PASS | `groupadd/useradd` 1001, `USER nextjs` before `CMD` |
| Writable state is created and owned before the volumes attach | PASS | `mkdir -p /app/data/{admin,db,storage} && chown -R nextjs:nodejs /app/data` — `/app` is root-owned and the server is uid 1001, so a lazily-created directory would EACCES on the first upload |
| A package is installed for every binary readiness demands | PASS | all seven checked against `lib/server/dependencyCheck.ts`, not a restated list |
| Node major still receiving security updates | PASS | `node:24-bookworm-slim`; `package.json` now declares `engines.node >= 24` |
| No developer database enters the build context | PASS | `.dockerignore` excludes `*.db`, `*.db-journal`, `*.sqlite`, `*.sqlite3`, `.storage`, `.env*`, `.next`, `.git`, `node_modules` |
| Compose supplies every variable the gate refuses to start without | PASS | `ADMIN_SECRET` (no default, `:?` fails fast), `NEXT_PUBLIC_SITE_URL`, `DATABASE_URL`, `DEPLOYMENT_TOPOLOGY` |
| Compose's database URL is one this schema can open | PASS | `file:` prefix, matching `provider = "sqlite"` |
| Live data lives outside the container layer | PASS | `DATABASE_URL` under `/app/data/db`, `STORAGE_LOCAL_ROOT` under `/app/data/storage`, both inside declared named volumes; every mount has a volume behind it |
| Horizontal scaling cannot be turned on by accident | PASS | fixed `container_name`, so `docker compose up --scale pdfdadi=2` fails; and the lease would 503 the second instance anyway |
| Liveness probe uses only what the slim image has | PASS | `node -e "fetch(…/api/health)"`, no curl; route exists at `app/api/health/route.ts` |

`npx vitest run deploymentArtifact.test.ts deploymentTopology.test.ts` → exit 0,
22 tests. The new CLI-path assertion was verified to fail when the path is changed
to `dist/index.js`.

## What remains unproven, and needs a host with a runtime

None of these can be inferred from the files, and none should be reported as
passing until an owner runs them:

1. The image **builds** — `npm ci`, `next build` inside the builder stage, and the
   apt install of LibreOffice/Ghostscript/Tesseract/OCRmyPDF resolving on
   `bookworm-slim`.
2. `migrate deploy` succeeds inside the container against a mounted volume,
   including the first run against an empty database.
3. The seven binaries are present **at the versions apt ships**, and
   `/api/health/ready` returns 200 rather than 503 — this host cannot show that,
   because `soffice` is absent here.
4. Volumes mount with the ownership the `chown` intends, and survive
   `docker compose down && up`.
5. The healthcheck transitions the container to `healthy`.
6. Image size, layer count, and a CVE scan.

## Owner-runnable container acceptance

Run on a host with a container runtime, from a clone of this branch:

```sh
export ADMIN_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export NEXT_PUBLIC_SITE_URL="https://<your-host>"

docker compose build            # passes NEXT_PUBLIC_SITE_URL as a build arg
docker compose up -d
docker compose logs -f pdfdadi  # expect: migrations applied, then the startup summary

# Readiness must be 200 with a body of all-true checks:
curl -fsS http://127.0.0.1:3000/api/health/ready | tee /dev/stderr | grep -q '"ok":true'

# The seven binaries, inside the image:
docker compose exec pdfdadi sh -c 'for b in soffice gs qpdf pdftoppm pdfinfo tesseract ocrmypdf; do command -v $b || echo "MISSING $b"; done'

# Restart safety: migrate deploy is a no-op the second time.
docker compose restart pdfdadi && docker compose logs --tail=40 pdfdadi

# Single instance is not negotiable — this must FAIL:
docker compose up -d --scale pdfdadi=2 || echo "correctly refused"
```

A `soffice`-absent readiness 503 on this machine is the same code path answering
correctly, and is recorded as ENVIRONMENTAL rather than as a product failure.
