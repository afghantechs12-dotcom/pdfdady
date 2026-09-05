/**
 * The single-instance lease: mutual exclusion, not a declaration.
 *
 * `DEPLOYMENT_TOPOLOGY=single-instance` validated that the operator had DECLARED
 * one instance. Two hand-started processes against the same database both booted,
 * both served, and both counted upload rate limits in their own memory — so the
 * global ceiling admitted twice its budget and SQLite got a second writer. This
 * module is the enforcement the variable was standing in for.
 *
 * ## How exclusion actually happens
 *
 * One row (`instance_leases`, id `app`) and one statement per attempt:
 *
 *   - `create` wins the first ever boot. A second process racing it gets a
 *     unique-constraint violation, which is a refusal, not an error.
 *   - afterwards, `updateMany` with `WHERE id = 'app' AND (holder = me OR expiresAt
 *     < now - grace)` updates exactly one row or none. Two processes cannot both
 *     see a free lease, because the read and the write are the same statement.
 *
 * `holder` identifies the PROCESS (`<host>:<pid>:<uuid>`), not the host. A restart
 * onto a recycled pid is a different holder, so a dead instance's lease can never
 * be mistaken for the new instance's own.
 *
 * ## Why a refused process does not exit
 *
 * It cannot serve — `guard.mjs` answers 503 to everything while the lease is not
 * held, before Next is invoked — so the safety property does not need an exit. And
 * exiting would turn every stale-lease window into a restart loop under Docker's
 * `restart: unless-stopped`. Instead the same interval that heartbeats a held lease
 * retries acquisition when it is not held, which makes a refused process a warm
 * standby: when the holder stops, the standby takes over within the TTL.
 *
 * ## The clock
 *
 * ponytail: staleness is judged on the application clock plus a grace margin. In
 * the supported topology (one host) every contender shares one clock, so this is
 * exact; beyond it, the grace margin absorbs small skew. A multi-host Postgres
 * deployment should move the comparison onto the database clock (`now()` in a raw
 * `UPDATE ... WHERE expiresAt < now()`), which costs one dialect branch — do it
 * when a second host becomes real, not before.
 *
 * Prisma connects at boot because of this module, which the startup path previously
 * avoided. That is deliberate: a lease that is not checked before the first request
 * is not a lease.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { ingressState, type LeaseStatus } from "@/src/infrastructure/config/ingressState";
import { getPrismaClient } from "@/src/infrastructure/db/prisma";

/** The fixed primary key. The row IS the lock, so the key is a constant. */
export const LEASE_ID = "app";

/**
 * How long a lease outlives its last heartbeat. Three missed beats: long enough
 * that a garbage-collection pause or a busy event loop does not hand the
 * deployment to a standby, short enough that a crashed instance is replaced in
 * about ten seconds.
 */
export const LEASE_TTL_MS = 10_000;

/** Beat, or retry acquisition, on one interval. */
export const HEARTBEAT_MS = 3_000;

/**
 * Extra delay before a contender treats an expired lease as stealable. Absorbs
 * clock skew between hosts; see the note above on which clock this uses.
 */
export const CLOCK_GRACE_MS = 2_000;

/**
 * This process, distinctly. The uuid is what makes it per-process rather than
 * per-host-and-pid, so a recycled pid cannot inherit a lease.
 */
export const holderId = `${hostname()}:${process.pid}:${randomUUID()}`;

let timer: ReturnType<typeof setInterval> | null = null;

function setLease(lease: LeaseStatus, detail: string): void {
  const state = ingressState();
  state.lease = lease;
  state.leaseDetail = detail;
}

/** True when the error is "that row already exists" rather than a real failure. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * One attempt. `true` when this process holds the lease afterwards.
 *
 * Throws only on a genuine database failure — a lost race is a `false`, because
 * the caller treats the two differently: a race means another instance is alive,
 * a failure means we do not know.
 */
async function tryAcquire(): Promise<boolean> {
  const prisma = getPrismaClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const stealableBefore = new Date(now.getTime() - CLOCK_GRACE_MS);

  try {
    await prisma.instanceLease.create({
      data: { id: LEASE_ID, holder: holderId, acquiredAt: now, heartbeatAt: now, expiresAt },
    });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // The row exists. Take it only if it is already ours or demonstrably abandoned.
  const { count } = await prisma.instanceLease.updateMany({
    where: {
      id: LEASE_ID,
      OR: [{ holder: holderId }, { expiresAt: { lt: stealableBefore } }],
    },
    data: { holder: holderId, acquiredAt: now, heartbeatAt: now, expiresAt },
  });
  return count === 1;
}

/**
 * Keep it, or take it.
 *
 * A held lease heartbeats; `count === 0` there means a contender decided we were
 * expired and took it, so we stop serving rather than write to a database another
 * instance now owns. A not-held lease retries acquisition, which is what makes a
 * refused process a standby.
 *
 * A database error is neither: it leaves the lease status alone. Losing the
 * database is already a readiness failure through `/api/health/ready`'s `database`
 * check, and treating one failed query as "stolen" would take a healthy instance
 * out of service for a blip.
 */
async function beat(): Promise<void> {
  const state = ingressState();
  try {
    if (state.lease === "held") {
      const prisma = getPrismaClient();
      const now = new Date();
      const { count } = await prisma.instanceLease.updateMany({
        where: { id: LEASE_ID, holder: holderId },
        data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
      });
      if (count === 0) {
        setLease("lost", `lease taken by another instance; ${holderId} is standing down`);
        console.error(
          "[instance] the single-instance lease was taken by another process. " +
            "This instance has stopped serving traffic and will retry.",
        );
      }
      return;
    }
    if (await tryAcquire()) {
      setLease("held", `held by ${holderId}`);
      console.info(`[instance] single-instance lease acquired by ${holderId}.`);
    }
  } catch (err) {
    console.warn(
      `[instance] lease heartbeat failed (keeping current status "${state.lease}"): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Give it up so the next process does not have to wait out the TTL.
 *
 * Scoped to `holder` so a process that already lost the lease cannot delete the
 * row a healthy instance is now using. Best effort by construction: the process is
 * exiting, and a SIGKILL skips this entirely — which is what the TTL is for.
 */
export async function releaseInstanceLease(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const state = ingressState();
  const wasHeld = state.lease === "held";
  setLease("released", "released on shutdown");
  if (!wasHeld) return;
  try {
    await getPrismaClient().instanceLease.deleteMany({
      where: { id: LEASE_ID, holder: holderId },
    });
  } catch (err) {
    console.warn(
      `[instance] could not release the lease cleanly; it will expire in ${
        LEASE_TTL_MS / 1000
      }s: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Acquire on boot, then keep it. Called from `instrumentation.ts`, so it runs
 * before the first request in every production topology.
 *
 * Returns the status rather than throwing on a lost race: being the second
 * instance is a legitimate outcome that the guard already handles by refusing
 * traffic. A database that cannot be reached at all is different — `pending` is
 * left in place, and the guard keeps refusing, which is the fail-closed direction.
 */
export async function startInstanceLease(): Promise<LeaseStatus> {
  const state = ingressState();

  // Nothing to exclude outside a production deployment: `next dev` is one
  // developer's process, a build phase serves nothing, and a lease taken here
  // would make a second `next dev` fail for no safety reason. `disabled` is a
  // serving status for the guard, unlike `pending`.
  if (process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE) {
    setLease("disabled", "no lease required outside a production deployment");
    return state.lease;
  }

  state.release = releaseInstanceLease;

  try {
    if (await tryAcquire()) {
      setLease("held", `held by ${holderId}`);
      console.info(`[instance] single-instance lease acquired by ${holderId}.`);
    } else {
      setLease(
        "refused",
        "another instance holds the single-instance lease; this process is a standby",
      );
      console.error(
        "[instance] REFUSED TO SERVE: another process already holds the single-instance " +
          "lease for this database. This instance will answer 503 to every request and " +
          "retry until the holder stops. Run exactly one instance per database — see " +
          "SERVER_SETUP.md, 'Instance topology'.",
      );
    }
  } catch (err) {
    setLease(
      "pending",
      `could not reach the database to acquire the lease: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.error(
      `[instance] could not acquire the single-instance lease: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing traffic until it succeeds.`,
    );
  }

  // `unref` so the interval never holds the process open on its own.
  timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref?.();
  return ingressState().lease;
}

/** Test-only: stop the interval without touching the row. */
export function _stopLeaseTimerForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
