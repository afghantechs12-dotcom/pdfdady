import { describe, expect, it } from "vitest";
import { AsyncMutex } from "./storeLock";

describe("AsyncMutex", () => {
  it("serializes concurrent runs with no overlap", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const makeRun = (id: string, ms: number) =>
      mutex.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end-${id}`);
        active--;
        return id;
      });

    const results = await Promise.all([
      makeRun("a", 20),
      makeRun("b", 10),
      makeRun("c", 5),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1); // never overlapped
    expect(order).toEqual([
      "start-a",
      "end-a",
      "start-b",
      "end-b",
      "start-c",
      "end-c",
    ]);
  });

  it("does not block subsequent runs after a failure", async () => {
    const mutex = new AsyncMutex();
    const first = mutex.run(async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    // The chain must still advance — a later run completes normally.
    await expect(mutex.run(async () => "ok")).resolves.toBe("ok");
  });

  it("preserves return values", async () => {
    const mutex = new AsyncMutex();
    await expect(mutex.run(async () => 42)).resolves.toBe(42);
  });
});
