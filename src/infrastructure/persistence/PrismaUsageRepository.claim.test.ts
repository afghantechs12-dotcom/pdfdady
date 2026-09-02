import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaUsageRepository } from "./PrismaUsageRepository";

/**
 * The durable settlement claim, against the adapter that actually holds it.
 *
 * `durableSettlement.test.ts` proves the SERVICE settles once when the claim
 * behaves. This proves the claim behaves — and specifically that the three
 * outcomes are distinguished, because conflating any two of them is a billing
 * bug rather than a test failure:
 *
 *   insert succeeded  → true  ("I won, apply the settlement")
 *   P2002             → false ("someone else won, do nothing")
 *   anything else     → throw ("unknown", which the service degrades on)
 *
 * A `catch` that returned false for every error is the dangerous version: a
 * connection outage would read as "already settled" and silently swallow every
 * refund the user was owed, with no counter moving and nothing logged.
 */

/** A real one: the adapter's guard is `instanceof`, so a `{code}` object would not exercise it. */
function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: "test",
  });
}

/** Minimal `usageSettlement` delegate that enforces the real primary key. */
function fakePrisma() {
  const rows = new Map<string, Date>();
  const prisma = {
    usageSettlement: {
      create: async ({ data }: { data: { key: string; claimedAt: Date } }) => {
        if (rows.has(data.key)) throw knownError("P2002");
        rows.set(data.key, data.claimedAt);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

const AT = new Date("2026-08-25T12:00:00.000Z");

describe("PrismaUsageRepository.claimSettlement", () => {
  it("claims an unseen key once and refuses it after", async () => {
    const { prisma, rows } = fakePrisma();
    const repo = new PrismaUsageRepository(prisma);

    expect(await repo.claimSettlement("job-1", AT)).toBe(true);
    expect(await repo.claimSettlement("job-1", AT)).toBe(false);
    // One row, so the constraint is what answered — not a cache in the adapter.
    expect([...rows.keys()]).toEqual(["job-1"]);
  });

  it("keys per job, so one settled job does not settle another", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaUsageRepository(prisma);
    expect(await repo.claimSettlement("job-1", AT)).toBe(true);
    expect(await repo.claimSettlement("job-2", AT)).toBe(true);
  });

  it("records the claim time it was given, not the row default", async () => {
    // The service settles into the RESERVATION's window, which can be yesterday's
    // when a job spans midnight. A claim stamped `now()` by the database would
    // make the marker disagree with the counter it protects.
    const { prisma, rows } = fakePrisma();
    await new PrismaUsageRepository(prisma).claimSettlement("job-1", AT);
    expect(rows.get("job-1")).toEqual(AT);
  });

  it("lets a genuine fault propagate instead of answering 'already claimed'", async () => {
    const failing = {
      usageSettlement: { create: () => Promise.reject(knownError("P1001")) },
    } as unknown as PrismaClient;
    // P1001 is "cannot reach database". Returning false here would be the silent
    // dropped-refund path; the service needs the throw to know it is degraded.
    await expect(
      new PrismaUsageRepository(failing).claimSettlement("job-1", AT),
    ).rejects.toMatchObject({ code: "P1001" });
  });

  it("propagates a plain error too, rather than pattern-matching a message", async () => {
    const failing = {
      usageSettlement: { create: () => Promise.reject(new Error("Unique constraint failed")) },
    } as unknown as PrismaClient;
    // Deliberately a message that LOOKS like a unique violation: the guard is
    // instanceof + code, so a thrown string cannot forge a claim outcome.
    await expect(
      new PrismaUsageRepository(failing).claimSettlement("job-1", AT),
    ).rejects.toThrow(/Unique constraint failed/);
  });

  it("survives concurrent claims on one key with exactly one winner", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaUsageRepository(prisma);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimSettlement("job-1", AT)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
