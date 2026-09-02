import { describe, expect, it } from "vitest";
import { makeImage, makeRect } from "@/src/domain/editor/testFactories";
import { resolveCropEligibility } from "./cropEligibility";

describe("resolveCropEligibility", () => {
  it("requires exactly one image", () => {
    expect(resolveCropEligibility([]).available).toBe(false);
    expect(resolveCropEligibility([makeRect()]).available).toBe(false);
    expect(resolveCropEligibility([makeImage(), makeImage()]).available).toBe(false);
  });

  it("rejects locked, hidden, invalid-size, and singular images", () => {
    expect(resolveCropEligibility([makeImage({ locked: true })]).available).toBe(false);
    expect(resolveCropEligibility([makeImage({ visible: false })]).available).toBe(false);
    expect(resolveCropEligibility([makeImage({ naturalWidth: 0 })]).available).toBe(false);
    expect(resolveCropEligibility([makeImage({ transform: { a: 1, b: 0, c: 1, d: 0, e: 0, f: 0 } })]).available).toBe(false);
  });

  it("returns the eligible image", () => {
    const image = makeImage();
    expect(resolveCropEligibility([image])).toEqual({ available: true, image });
  });
});
