import { describe, expect, it, vi } from "vitest";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";

/**
 * Job ids must identify one job.
 *
 * This exists because the obvious way to check it does not work. The collision
 * this file pins was found by an integration test that scans a shared scratch
 * root for directories named after its job — and that test failed for it only
 * sometimes, on a different assertion each run, because it needed a sibling
 * vitest fork to be holding a colliding directory at the exact moment it looked.
 * Removing the fix and running the whole suite twice did not bring the failure
 * back. A guard that reproduces two runs in three is not a guard.
 *
 * So the invariant is asserted directly here instead of being left to a race.
 * Loading the module twice is a faithful stand-in for two processes: the id
 * counter is module state, so a fresh load restarts it exactly as a new fork
 * would, and anything that makes ids unique has to survive that.
 */

async function freshRepo(): Promise<IJobRepository> {
  vi.resetModules();
  const mod = await import("@/src/infrastructure/persistence/InMemoryJobRepository");
  return new mod.InMemoryJobRepository();
}

async function firstIds(count: number): Promise<string[]> {
  const repo = await freshRepo();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const job = await repo.create({ type: "processing", payload: "{}" });
    ids.push(job.id);
  }
  return ids;
}

describe("InMemoryJobRepository ids", () => {
  it("does not reissue the same id to a second process", async () => {
    const a = await firstIds(5);
    const b = await firstIds(5);

    // The counter alone would make these two lists identical.
    expect(a).not.toEqual(b);
    expect(new Set([...a, ...b]).size).toBe(10);
  });

  it("keeps ids unique within one process", async () => {
    const ids = await firstIds(50);
    expect(new Set(ids).size).toBe(50);
  });

  it("is still safe to use as a path segment", async () => {
    // Ids become work-directory names and storage key segments. Entropy that
    // introduced a slash, a dot-dot or a space would trade a collision bug for a
    // traversal bug, so the shape is constrained rather than merely unique.
    for (const id of await firstIds(20)) {
      expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
});
