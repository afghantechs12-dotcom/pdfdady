import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingressState } from "@/src/infrastructure/config/ingressState";

/**
 * The single-instance lease, driven through a fake Prisma delegate.
 *
 * What is being tested here is the decision the lease makes from what the database
 * says: a lost race is a refusal and not an error, an unreachable database leaves
 * the process refusing traffic, and a heartbeat that updates nothing means someone
 * else has taken over. The live proof that two real processes exclude each other is
 * `scripts/singleton-probe.mjs`; these are the branches that are awkward to
 * provoke on a real database and cheap to provoke here.
 */

const lease = {
  create: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock("@/src/infrastructure/db/prisma", () => ({
  getPrismaClient: () => ({ instanceLease: lease }),
}));

const P2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

async function freshModule() {
  vi.resetModules();
  return import("@/src/infrastructure/config/instanceLease");
}

beforeEach(() => {
  lease.create.mockReset();
  lease.updateMany.mockReset();
  lease.deleteMany.mockReset();
  const state = ingressState();
  state.lease = "pending";
  state.leaseDetail = "";
  vi.stubEnv("NODE_ENV", "production");
  delete process.env.NEXT_PHASE;
});

afterEach(async () => {
  const mod = await import("@/src/infrastructure/config/instanceLease");
  mod._stopLeaseTimerForTests();
  vi.unstubAllEnvs();
});

describe("the constants", () => {
  it("gives the holder three heartbeats before the lease is stealable", async () => {
    const { LEASE_TTL_MS, HEARTBEAT_MS, CLOCK_GRACE_MS } = await freshModule();
    expect(HEARTBEAT_MS * 3).toBeLessThanOrEqual(LEASE_TTL_MS);
    expect(LEASE_TTL_MS).toBeGreaterThan(HEARTBEAT_MS);
    // A contender waits out the TTL AND the grace, so a small clock difference
    // between two processes cannot make a live lease look abandoned.
    expect(CLOCK_GRACE_MS).toBeGreaterThan(0);
  });

  it("identifies the process, not the host or the pid", async () => {
    const { holderId } = await freshModule();
    const [, pid, uuid] = holderId.split(":");
    expect(pid).toBe(String(process.pid));
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("acquisition", () => {
  it("holds the lease when the row did not exist", async () => {
    lease.create.mockResolvedValue({});
    const { startInstanceLease } = await freshModule();
    expect(await startInstanceLease()).toBe("held");
    expect(lease.updateMany).not.toHaveBeenCalled();
  });

  it("refuses — without throwing — when another process already holds it", async () => {
    lease.create.mockRejectedValue(P2002);
    lease.updateMany.mockResolvedValue({ count: 0 });
    const { startInstanceLease } = await freshModule();
    expect(await startInstanceLease()).toBe("refused");
    expect(ingressState().leaseDetail).toMatch(/standby/);
  });

  it("takes over a lease that expired more than the grace margin ago", async () => {
    lease.create.mockRejectedValue(P2002);
    lease.updateMany.mockResolvedValue({ count: 1 });
    const { startInstanceLease, CLOCK_GRACE_MS, holderId } = await freshModule();
    expect(await startInstanceLease()).toBe("held");

    // One statement decides it: the read and the write are the same `updateMany`,
    // so two contenders cannot both see a free lease.
    const where = lease.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe("app");
    expect(where.OR[0]).toEqual({ holder: holderId });
    const stealableBefore = where.OR[1].expiresAt.lt as Date;
    expect(Date.now() - stealableBefore.getTime()).toBeGreaterThanOrEqual(CLOCK_GRACE_MS);
  });

  it("stays pending — refusing traffic — when the database cannot be reached", async () => {
    lease.create.mockRejectedValue(new Error("ECONNREFUSED"));
    const { startInstanceLease } = await freshModule();
    expect(await startInstanceLease()).toBe("pending");
    expect(ingressState().leaseDetail).toMatch(/could not reach the database/);
  });

  it("does not touch the database outside a production deployment", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { startInstanceLease } = await freshModule();
    expect(await startInstanceLease()).toBe("disabled");
    expect(lease.create).not.toHaveBeenCalled();
  });

  it("does not touch the database during a build phase", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    const { startInstanceLease } = await freshModule();
    expect(await startInstanceLease()).toBe("disabled");
    expect(lease.create).not.toHaveBeenCalled();
  });
});

describe("the heartbeat", () => {
  it("stands down when a contender has taken the lease", async () => {
    vi.useFakeTimers();
    try {
      lease.create.mockResolvedValue({});
      const { startInstanceLease, HEARTBEAT_MS } = await freshModule();
      expect(await startInstanceLease()).toBe("held");

      // The holder's own heartbeat is scoped to `holder = me`, so updating nothing
      // means the row is no longer ours — a stolen lease, not a database error.
      lease.updateMany.mockResolvedValue({ count: 0 });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(ingressState().lease).toBe("lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving through a database blip rather than standing down", async () => {
    vi.useFakeTimers();
    try {
      lease.create.mockResolvedValue({});
      const { startInstanceLease, HEARTBEAT_MS } = await freshModule();
      await startInstanceLease();

      lease.updateMany.mockRejectedValue(new Error("database is locked"));
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      // One failed query is not evidence that another instance took over, and
      // standing down here would take a healthy deployment out of service.
      expect(ingressState().lease).toBe("held");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries acquisition while refused, which is what makes a standby warm", async () => {
    vi.useFakeTimers();
    try {
      lease.create.mockRejectedValue(P2002);
      lease.updateMany.mockResolvedValue({ count: 0 });
      const { startInstanceLease, HEARTBEAT_MS } = await freshModule();
      expect(await startInstanceLease()).toBe("refused");

      lease.updateMany.mockResolvedValue({ count: 1 });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(ingressState().lease).toBe("held");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("release", () => {
  it("deletes only its own row", async () => {
    lease.create.mockResolvedValue({});
    lease.deleteMany.mockResolvedValue({ count: 1 });
    const { startInstanceLease, releaseInstanceLease, holderId } = await freshModule();
    await startInstanceLease();
    await releaseInstanceLease();
    expect(lease.deleteMany).toHaveBeenCalledWith({ where: { id: "app", holder: holderId } });
    expect(ingressState().lease).toBe("released");
  });

  it("does not delete anything when it never held the lease", async () => {
    lease.create.mockRejectedValue(P2002);
    lease.updateMany.mockResolvedValue({ count: 0 });
    const { startInstanceLease, releaseInstanceLease } = await freshModule();
    await startInstanceLease();
    await releaseInstanceLease();
    expect(lease.deleteMany).not.toHaveBeenCalled();
  });

  it("survives a database that refuses the delete", async () => {
    lease.create.mockResolvedValue({});
    lease.deleteMany.mockRejectedValue(new Error("gone"));
    const { startInstanceLease, releaseInstanceLease } = await freshModule();
    await startInstanceLease();
    await expect(releaseInstanceLease()).resolves.toBeUndefined();
  });
});
