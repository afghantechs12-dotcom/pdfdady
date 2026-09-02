# Mutation C — the container deployment path

Gate: `npx vitest run deploymentArtifact.test.ts` (7 tests green at `30d1f21`).

| # | Mutation | Observed | Red assertion |
|---|----------|----------|---------------|
| C1 | `DATABASE_URL` line deleted from `docker-compose.yml` | 3 failed / 4 passed | supplies every variable the production gate refuses to start without; names a database URL this Prisma schema can actually open; keeps the database and the stored documents outside the container layer |
| C2 | `COPY --from=builder /app/public ./public` restored | 1 failed / 6 passed | copies only paths that exist — `COPY source missing: public` |
| C3 | all three stages back to `node:20-bookworm-slim` | 1 failed / 6 passed | runs on a Node major that still receives security updates |
| C4 | `pdfdadi-storage:/app/data/storage` mount deleted | 1 failed / 6 passed | keeps the database and the stored documents outside the container layer |
| C5 | `CMD` back to `["node", "server.js"]` | 1 failed / 6 passed | carries the migration toolchain the standalone output leaves behind |

## C2 failed on the first attempt, and that is recorded rather than tidied away

The first version of the COPY-existence check skipped every `COPY --from=<stage>`
line on the theory that only build-context copies could be verified without a
daemon. `COPY --from=builder /app/public ./public` is a `--from` line, so the
check could not see the very defect it was written for: C2 came back **7 passed**.

The reader now resolves `/app/<path>` in any stage onto `<path>` in this
repository — both earlier stages are `/app` working directories built from this
tree — and C2 fails with `COPY source missing: public`. A guard no fixture can
reach is worth nothing, and the mutation is what proved it.

Every mutation reverted with `git checkout --`; the gate is green afterwards.
