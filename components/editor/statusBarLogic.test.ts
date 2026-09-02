import { describe, expect, it } from "vitest";
import {
  IDLE_INTERACTION,
  TOOL_LABELS,
  formatPageCoords,
  formatZoomPercent,
  interactionSummary,
  kindLabel,
  summarizeSelection,
} from "./statusBarLogic";
import { ALL_EDITOR_TOOLS } from "./editorTypes";

describe("kindLabel", () => {
  it("labels the built-in kinds", () => {
    expect(kindLabel("text")).toBe("Text");
    expect(kindLabel("annotation")).toBe("Note");
    expect(kindLabel("signature")).toBe("Signature");
  });

  it("capitalizes unknown (plugin) kinds", () => {
    expect(kindLabel("stamp")).toBe("Stamp");
    expect(kindLabel("")).toBe("Object");
  });
});

describe("summarizeSelection", () => {
  it("no selection", () => {
    expect(summarizeSelection([])).toBe("No selection");
  });

  it("single object shows its kind", () => {
    expect(summarizeSelection(["text"])).toBe("Text");
    expect(summarizeSelection(["image"])).toBe("Image");
  });

  it("homogeneous multi-selection shows count + kind", () => {
    expect(summarizeSelection(["text", "text", "text"])).toBe("3 Text objects");
  });

  it("mixed multi-selection shows the count", () => {
    expect(summarizeSelection(["text", "shape", "image"])).toBe("3 objects");
  });
});

describe("formatPageCoords", () => {
  it("rounds to whole page units", () => {
    expect(formatPageCoords({ x: 123.4, y: 456.6 })).toBe("123, 457");
  });

  it("em dash when the pointer is outside", () => {
    expect(formatPageCoords(null)).toBe("—");
  });
});

describe("formatZoomPercent", () => {
  it("formats whole percentages", () => {
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(0.1)).toBe("10%");
    expect(formatZoomPercent(1.254)).toBe("125%");
  });
});

describe("TOOL_LABELS", () => {
  it("covers every editor tool", () => {
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...ALL_EDITOR_TOOLS].sort());
  });
});

describe("interactionSummary (M6.14)", () => {
  it("is null while idle (the status bar hides the field)", () => {
    expect(interactionSummary(IDLE_INTERACTION)).toBeNull();
    expect(interactionSummary({ cropDraft: null, pathAnchorCount: 0 })).toBeNull();
  });

  it("shows the live crop size in whole natural px with the key hints", () => {
    const s = interactionSummary({
      cropDraft: { x: 10, y: 20, width: 199.6, height: 80.2 },
      pathAnchorCount: 0,
    });
    expect(s).toContain("Crop: 200 × 80 px");
    expect(s).toMatch(/Enter/);
    expect(s).toMatch(/Esc/);
  });

  it("shows the pen anchor count with correct pluralization", () => {
    expect(
      interactionSummary({ cropDraft: null, pathAnchorCount: 1 }),
    ).toContain("Pen: 1 anchor —");
    expect(
      interactionSummary({ cropDraft: null, pathAnchorCount: 4 }),
    ).toContain("Pen: 4 anchors");
  });

  it("crop wins if both are somehow set (belt-and-braces ordering)", () => {
    const s = interactionSummary({
      cropDraft: { x: 0, y: 0, width: 50, height: 50 },
      pathAnchorCount: 3,
    });
    expect(s).toContain("Crop:");
  });
});
