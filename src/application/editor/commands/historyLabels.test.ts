import { describe, expect, it } from "vitest";

import {
  groupHistoryRows,
  historyPhrase,
  subjectNoun,
} from "@/src/application/editor/commands/historyLabels";
import { SHAPE_KIND_LABELS } from "@/src/domain/editor/shapeGeometry";
import type { ShapeKind } from "@/src/domain/editor/objects";

describe("subjectNoun", () => {
  it("names a shape by its specific kind, not the word 'shape'", () => {
    expect(subjectNoun("shape", "rect")).toBe("rectangle");
    expect(subjectNoun("shape", "ellipse")).toBe("ellipse");
    expect(subjectNoun("shape", "star")).toBe("star");
  });

  it("falls back to 'shape' when the kind is unknown", () => {
    expect(subjectNoun("shape")).toBe("shape");
  });

  it("uses the product word for annotations", () => {
    // The UI calls these Comments; "annotation" is implementation vocabulary.
    expect(subjectNoun("annotation")).toBe("comment");
  });

  it("covers every shape kind without producing an empty or undefined noun", () => {
    for (const kind of Object.keys(SHAPE_KIND_LABELS) as ShapeKind[]) {
      const noun = subjectNoun("shape", kind);
      expect(noun.length).toBeGreaterThan(0);
      expect(noun).toBe(noun.toLowerCase());
    }
  });

  it("names every non-shape object kind", () => {
    expect(subjectNoun("text")).toBe("text");
    expect(subjectNoun("image")).toBe("image");
    expect(subjectNoun("drawing")).toBe("drawing");
    expect(subjectNoun("highlight")).toBe("highlight");
    expect(subjectNoun("signature")).toBe("signature");
  });
});

describe("historyPhrase", () => {
  it("turns the generic 'Add object' into the thing actually added", () => {
    // This is the defect: every creation path in the service labels its command
    // "Add object", so a rectangle and an image were indistinguishable.
    expect(historyPhrase("Add object", "shape", "rect")).toBe("Added rectangle");
    expect(historyPhrase("Add object", "image")).toBe("Added image");
    expect(historyPhrase("Add object", "drawing")).toBe("Added drawing");
    expect(historyPhrase("Add object", "annotation")).toBe("Added comment");
  });

  it("degrades to 'Added object' when the kind is unknown", () => {
    expect(historyPhrase("Add object")).toBe("Added object");
  });

  it("puts the subject on a movement so a run of drags is readable", () => {
    // The recording showed: Move / Move / Move / Move.
    expect(historyPhrase("Move", "image")).toBe("Moved image");
    expect(historyPhrase("Resize", "shape", "rect")).toBe("Resized rectangle");
    expect(historyPhrase("Rotate", "text")).toBe("Rotated text");
  });

  it("still reads correctly with no subject", () => {
    expect(historyPhrase("Move")).toBe("Moved");
    expect(historyPhrase("Delete")).toBe("Deleted");
  });

  it("normalises product-language labels the canvas already writes", () => {
    expect(historyPhrase("Add rectangle")).toBe("Added rectangle");
    expect(historyPhrase("Add highlight")).toBe("Added highlight");
  });

  it("uses past tense for text editing", () => {
    expect(historyPhrase("Edit text", "text")).toBe("Edited text");
  });

  it("reads page navigation as a place", () => {
    expect(historyPhrase("Switch page")).toBe("Switched page");
  });

  it("passes an unmapped label through unchanged rather than mangling it", () => {
    // A new command showing its own label is a cosmetic gap; inventing a wrong
    // phrase for it would misdescribe what Undo will do.
    expect(historyPhrase("Set gradient stops")).toBe("Set gradient stops");
  });

  it("never returns an empty string", () => {
    expect(historyPhrase("")).toBe("Edited document");
    expect(historyPhrase("   ")).toBe("Edited document");
  });

  it("exposes no implementation vocabulary for the labels in use", () => {
    const forbidden = /object\.|command|mutat|dispatch|payload|reducer/i;
    const labels = [
      "Add object", "Move", "Resize", "Rotate", "Delete", "Erase", "Crop image",
      "Edit text", "Edit property", "Switch page", "Bring to front", "Send to back",
    ];
    for (const label of labels) {
      expect(historyPhrase(label, "shape", "rect")).not.toMatch(forbidden);
    }
  });
});

describe("groupHistoryRows", () => {
  it("collapses a run of identical phrases into one counted row", () => {
    const rows = groupHistoryRows(["Moved image", "Moved image", "Moved image"]);
    expect(rows).toEqual([{ phrase: "Moved image", count: 3, depth: 3 }]);
  });

  it("keeps distinct phrases as separate rows in order", () => {
    const rows = groupHistoryRows(["Added rectangle", "Moved image", "Deleted text"]);
    expect(rows.map((r) => r.phrase)).toEqual(["Added rectangle", "Moved image", "Deleted text"]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it("does not merge non-consecutive duplicates", () => {
    const rows = groupHistoryRows(["Moved image", "Added text", "Moved image"]);
    expect(rows).toHaveLength(3);
  });

  it("assigns each row the depth of the newest step in its run", () => {
    // jumpTo() consumes these depths, so grouping must not break navigation.
    const rows = groupHistoryRows(["Added rectangle", "Moved image", "Moved image", "Deleted text"]);
    expect(rows.map((r) => r.depth)).toEqual([1, 3, 4]);
  });

  it("preserves the total step count across all rows", () => {
    const phrases = ["A", "A", "B", "C", "C", "C"];
    const rows = groupHistoryRows(phrases);
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(phrases.length);
  });

  it("the last row's depth always equals the total number of steps", () => {
    const phrases = ["A", "A", "B", "B", "B"];
    const rows = groupHistoryRows(phrases);
    expect(rows[rows.length - 1].depth).toBe(phrases.length);
  });

  it("handles an empty history", () => {
    expect(groupHistoryRows([])).toEqual([]);
  });
});
