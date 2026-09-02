import { beforeEach, describe, expect, it } from "vitest";
import { makeRect, resetFactory } from "./testFactories";
import { getGroupId, sameGroup, setGroupId } from "./objects";

describe("grouping metadata helpers", () => {
  beforeEach(() => resetFactory());

  it("getGroupId returns null for an ungrouped object", () => {
    const r = makeRect();
    expect(getGroupId(r)).toBeNull();
  });

  it("setGroupId stamps + clears the group id immutably", () => {
    const r = makeRect();
    const g = setGroupId(r, "g1");
    expect(getGroupId(g)).toBe("g1");
    expect(getGroupId(r)).toBeNull(); // original unchanged
    const cleared = setGroupId(g, null);
    expect(getGroupId(cleared)).toBeNull();
    // Clearing removes the key rather than leaving a null value.
    expect(cleared.metadata).not.toHaveProperty("groupId");
  });

  it("sameGroup is true only for a shared, non-null group id", () => {
    const a = setGroupId(makeRect(), "g1");
    const b = setGroupId(makeRect(), "g1");
    const c = setGroupId(makeRect(), "g2");
    const d = makeRect();
    expect(sameGroup(a, b)).toBe(true);
    expect(sameGroup(a, c)).toBe(false);
    expect(sameGroup(a, d)).toBe(false);
    expect(sameGroup(d, makeRect())).toBe(false);
  });
});
