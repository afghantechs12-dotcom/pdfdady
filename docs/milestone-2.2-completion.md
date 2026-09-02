# Milestone 2.2 — Storage Layer (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27

M2.2 adds the provider-agnostic object-storage layer: ports for object storage,
multipart upload, signed URLs, file metadata, and the upload/download use
cases; a **Local filesystem adapter** (dev/standalone) and a **Cloudflare R2
adapter** (S3-compatible, prod) for each; a Prisma-backed `StoredFile`
metadata repository; DI wiring that selects R2 when its credentials are present
and falls back to local storage otherwise; and the HTTP routes that drive
multipart uploads + serve local signed URLs. Business logic depends only on
the storage interfaces — it never knows whether bytes live on disk or in R2.
**Zero cloud credentials required to build/test** — the R2 adapters are only
constructed when R2 is configured.

## What landed

**Ports (src/application/ports/storage/):** `IObjectStorage`, `IMultipartUpload`,
`ISignedUrlService`, `IFileMetadataRepository`, `IUploadService`,
`IDownloadService`.

**Domain:** `StoredFile` entity (+ `StoredFileOwnerType` tenant scope).

**Infrastructure adapters (src/infrastructure/storage/):**
- `LocalFileStorage` (node:fs, path-traversal-safe) · `R2ObjectStorage` (S3 SDK).
- `LocalSignedUrlService` (HMAC-signed local URLs) · `R2SignedUrlService`
  (S3 presigning). Shared `localSignedUrl.ts` sign/verify helper.
- `LocalMultipartUpload` (app-mediated parts → concat) · `R2MultipartUpload`
  (real S3 multipart; client PUTs parts directly to presigned URLs — no app buffering).

**Persistence:** `PrismaStoredFileRepository` + `InMemoryStoredFileRepository`
(against the existing `StoredFile` table from the M2.1 schema).

**Application services:** `UploadService` (sha256 → per-owner dedup +
content-addressed byte-level dedup → store → metadata) · `DownloadService`
(signed URL for a file's storage key).

**Routes:** `POST /api/storage/multipart` (create), `PUT/POST/DELETE
/api/storage/multipart/[...segments]` (part / complete / abort), `GET
/api/storage/file` (local signed-URL serving with HMAC + expiry verification).

**Config:** `env.ts` gained optional R2 fields (`R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`),
`STORAGE_LOCAL_ROOT`, `STORAGE_SIGNING_SECRET` → a `StorageConfig` with
`provider: "local" | "r2"`. DI selects the provider from config.

**DI:** `Tokens.ObjectStorage | SignedUrlService | FileMetadataRepository |
UploadService | DownloadService | MultipartUpload` wired in `container.ts`
to Local or R2 adapters based on `config.storage.provider`.

## Files

**New (16):** 6 storage ports, 1 domain entity, 9 infrastructure adapters/util/repos, 2 application services, 3 routes, 5 test files.
**Edited:** `src/infrastructure/config/env.ts` (storage config), `src/application/di/tokens.ts` + `container.ts` (wiring), `package.json` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).

## Tests added

`npm run test` → **54 passed (14 files)**. New M2.2 tests (13):
- `LocalFileStorage` (4) — put/get/head/delete, missing-key throw, idempotent delete, path-traversal rejection.
- `UploadService` (3) — new file, per-owner dedup, byte-level cross-owner dedup.
- `LocalSignedUrlService` (2) — verifiable URL with key+verb+expiry bound, expiry math.
- `LocalMultipartUpload` (2) — create→receive→complete round-trip, abort cleanup.
- `DownloadService` (2) — signed URL for existing file, null for missing.

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing, unchanged) |
| `npm run test` | 54/54 passed (14 files) |
| `npm run build` | exit 0 — standalone build; AWS SDK bundled; storage routes compiled |

## Performance / security / SEO impact

- **Performance:** additive — no existing request path changed. The storage
  layer is not yet wired into the existing tool routes (that is M3, when server
  tools stream to/from storage instead of buffering). The new flows are
  designed to keep the app server out of the byte path: R2 multipart + signed
  URLs mean large files never buffer in Node; the local adapter buffers on
  complete (dev only). sha256 dedup avoids re-storing identical bytes.
- **Security:** positive — content-addressed keys + per-owner metadata rows
  enforce tenant isolation at the storage layer; signed URLs bind key+verb+expiry
  (HMAC) and expire; path traversal blocked in the local adapter. R2 creds are
  only read when present; no secrets in the local path. Ownership enforcement
  on downloads is deferred to M2.4 (auth).
- **SEO:** none — `/api/storage/*` are noindex JSON/binary endpoints, not linked
  from the site.

## Breaking changes

None. The storage layer is purely additive; no existing route, component, or
data file changed. R2 credentials are optional — without them the app uses the
local filesystem adapter and everything builds/runs.

## Remaining M2 tasks

- **M2.3 — Queue Layer:** Redis `IQueue`/`IWorker` adapter, job scheduler,
  retry/backoff, progress events, cancellation, dead-letter queue (the
  interfaces + in-memory adapter already exist from M2.1).
- **M2.4 — Authentication:** user/session/org/role provider interfaces; local
  auth implementation + Clerk adapter (no Clerk integration yet).
- **M2.5 — Observability:** metrics/tracing/analytics/error-reporting
  interfaces + local implementations; Sentry/PostHog adapters later.
- **Follow-up:** wire the storage layer into the server tool routes in M3
  (stream uploads to storage, return signed download URLs — closes the residual
  M1 in-memory buffering vector); add a retention purge job (the
  `listExpired` repo method + the queue scheduler from M2.3).
