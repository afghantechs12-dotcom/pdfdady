/**
 * A test that fails on purpose. R4 in `finalReconciliation.test.ts` runs this
 * through `scripts/suite-evidence.mjs` and then asserts the retained artifacts
 * actually name it — which is the one thing the original unidentified failure
 * could not do.
 *
 * Named `.fixture.ts`, not `.test.ts`, so the real suite's
 * `include: ["**\/*.test.ts"]` can never collect it. It runs only via
 * `test/fixtures/vitest.fixture.config.ts`, which names it explicitly.
 */
import { describe, expect, it } from "vitest";

describe("evidence harness fixture", () => {
  it("fails so that a retained artifact has a failure to carry", () => {
    expect(1 + 1, "this fixture is supposed to be red").toBe(3);
  });

  it("passes, so the artifact has to distinguish the two", () => {
    expect(1 + 1).toBe(2);
  });
});
