import { describe, expect, it, beforeEach } from "vitest";

import {
  hasFixedAspectByDefault,
  shouldLockAspect,
} from "@/src/application/editor/transform/aspectConstraint";
import {
  makeAnnotation,
  makeDrawing,
  makeImage,
  makeRect,
  makeSignature,
  makeTextObject,
  resetFactory,
} from "@/src/domain/editor/testFactories";

/**
 * The contract: pixel content defends its proportions, everything else stays
 * free, and Shift inverts whichever default applies. Both directions are asserted
 * — locking every object would "fix" image distortion by making the shape tools
 * useless, and the escape hatch has to keep working or the lock removes a
 * capability the editor used to have.
 */
describe("shouldLockAspect", () => {
  beforeEach(resetFactory);

  describe("pixel content is locked by default", () => {
    it("locks an image corner drag", () => {
      expect(hasFixedAspectByDefault(makeImage())).toBe(true);
      expect(shouldLockAspect(makeImage(), false)).toBe(true);
    });

    it("locks a signature — a stretched signature reads as a forged one", () => {
      expect(hasFixedAspectByDefault(makeSignature())).toBe(true);
      expect(shouldLockAspect(makeSignature(), false)).toBe(true);
    });

    it("frees it while Shift is held, so a deliberate stretch is still possible", () => {
      expect(shouldLockAspect(makeImage(), true)).toBe(false);
      expect(shouldLockAspect(makeSignature(), true)).toBe(false);
    });
  });

  describe("vector and text content stays free by default", () => {
    it("a shape resizes freely — becoming a different rectangle is the point", () => {
      expect(hasFixedAspectByDefault(makeRect())).toBe(false);
      expect(shouldLockAspect(makeRect(), false)).toBe(false);
    });

    it("a text frame, a drawing and a note resize freely too", () => {
      expect(shouldLockAspect(makeTextObject(), false)).toBe(false);
      expect(shouldLockAspect(makeDrawing(), false)).toBe(false);
      expect(shouldLockAspect(makeAnnotation(), false)).toBe(false);
    });

    it("Shift constrains them, the way every drawing tool's Shift does", () => {
      expect(shouldLockAspect(makeRect(), true)).toBe(true);
      expect(shouldLockAspect(makeTextObject(), true)).toBe(true);
    });
  });

  it("never locks a multi-selection (no single ratio to preserve)", () => {
    // The canvas passes null for a group; `resizeSelection` scales about the
    // selection box and would need its own rule to do anything else.
    expect(shouldLockAspect(null, false)).toBe(false);
    expect(shouldLockAspect(null, true)).toBe(false);
    expect(shouldLockAspect(undefined, true)).toBe(false);
    expect(hasFixedAspectByDefault(null)).toBe(false);
  });
});
