import { describe, expect, it } from "vitest";
import { isObjectKind } from "./objects";
import {
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeTextObject,
  resetFactory,
} from "./testFactories";

describe("editor objects", () => {
  it("isObjectKind narrows the union to a specific kind", () => {
    const text = makeTextObject();
    if (isObjectKind(text, "text")) {
      // Narrowed: text field accessible.
      expect(text.text).toBe("Hello");
    } else {
      throw new Error("should have narrowed to text");
    }
  });

  it("isObjectKind returns false for a mismatched kind", () => {
    const rect = makeRect();
    expect(isObjectKind(rect, "text")).toBe(false);
    expect(isObjectKind(rect, "shape")).toBe(true);
  });

  it("each factory produces its declared kind", () => {
    expect(makeTextObject().kind).toBe("text");
    expect(makeRect().kind).toBe("shape");
    expect(makeImage().kind).toBe("image");
    expect(makeHighlight().kind).toBe("highlight");
    expect(makeDrawing().kind).toBe("drawing");
  });

  it("factory ids are unique and resettable", () => {
    resetFactory();
    expect(makeRect().id).toBe("obj-1");
    expect(makeRect().id).toBe("obj-2");
    resetFactory();
    expect(makeRect().id).toBe("obj-1");
  });
});
