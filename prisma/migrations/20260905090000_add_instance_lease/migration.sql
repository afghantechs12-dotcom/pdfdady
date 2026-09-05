-- The single-instance lease: one row that a second process cannot also hold.
--
-- `DEPLOYMENT_TOPOLOGY=single-instance` was config validation — it checked that the
-- operator had declared one instance, and two hand-started processes against the
-- same database both booted anyway. This table is the enforcement: acquisition is a
-- compare-and-swap on one row, so the loser is refused before it serves traffic.
--
-- Purely additive. One new table, no existing table touched, no data rewritten, and
-- nothing reads it except the startup path. Rolling back is symmetric: drop the
-- table and the application falls back to declaring the topology without enforcing
-- it, which is exactly the pre-migration behaviour.
--
-- No index beyond the primary key on purpose: every access is `WHERE id = 'app'`,
-- which the primary key already serves, and the table holds exactly one row.

-- CreateTable
CREATE TABLE "instance_leases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holder" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "heartbeatAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);
