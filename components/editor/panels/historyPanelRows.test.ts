import { describe, expect, it } from "vitest";

import {
  historyPanelRows,
  rowAccessibleName,
  type HistoryPanelRow,
} from "@/components/editor/panels/historyPanelRows";

/**
 * These tests exist for one reason: grouping the History panel's rows changes
 * the mapping from a rendered row to a `jumpTo` argument, and a wrong argument
 * silently sends the user to a different document state. The panel used to pass
 * `i + 1` for past entries and `undoDepth + j + 1` for future entries, so every
 * ungrouped case here asserts against those exact formulas.
 */

describe("historyPanelRows — empty history", () => {
  it("reports empty when both stacks are empty", () => {
    const model = historyPanelRows([], [], 0);
    expect(model.empty).toBe(true);
    expect(model.past).toEqual([]);
    expect(model.future).toEqual([]);
  });

  it("is not empty when only the redo stack has entries", () => {
    // Undo everything and the past is empty but the panel still has content.
    const model = historyPanelRows([], ["Move"], 0);
    expect(model.empty).toBe(false);
    expect(model.future).toHaveLength(1);
  });

  it("is not empty when only the undo stack has entries", () => {
    const model = historyPanelRows(["Move"], [], 1);
    expect(model.empty).toBe(false);
    expect(model.past).toHaveLength(1);
  });
});

describe("historyPanelRows — ungrouped rows keep the original jump targets", () => {
  it("passes i + 1 for every past entry when no two are alike", () => {
    const labels = ["Add object", "Move", "Resize", "Delete"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past).toHaveLength(labels.length);
    past.forEach((row, i) => {
      expect(row.count).toBe(1);
      expect(row.jumpDepth).toBe(i + 1);
    });
  });

  it("passes undoDepth + j + 1 for every future entry when no two are alike", () => {
    const undoDepth = 3;
    const labels = ["Move", "Resize", "Delete"];
    const { future } = historyPanelRows([], labels, undoDepth);

    expect(future).toHaveLength(labels.length);
    future.forEach((row, j) => {
      expect(row.count).toBe(1);
      expect(row.jumpDepth).toBe(undoDepth + j + 1);
    });
  });

  it("makes the newest past row a no-op jump, exactly as before", () => {
    // Clicking the entry immediately above "Current" targets the current depth.
    const labels = ["Add object", "Move"];
    const { past } = historyPanelRows(labels, [], labels.length);
    expect(past[past.length - 1].jumpDepth).toBe(labels.length);
  });
});

describe("historyPanelRows — a grouped row jumps to the right undo depth", () => {
  it("targets the NEWEST entry of a collapsed past run", () => {
    // Five drags coalesce into "Moved ×5". The row presents the run as one
    // action, so jumping to it must leave all five applied — depth 6, not 2.
    const labels = ["Add object", "Move", "Move", "Move", "Move", "Move"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past).toHaveLength(2);
    expect(past[0]).toEqual({ phrase: "Added object", count: 1, jumpDepth: 1 });
    expect(past[1]).toEqual({ phrase: "Moved", count: 5, jumpDepth: 6 });
  });

  it("keeps later past rows on their true depths after a run collapses", () => {
    // The row INDEX no longer equals the depth once a run collapses; the depth
    // must still count raw entries.
    const labels = ["Move", "Move", "Move", "Resize", "Delete"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past.map((r) => [r.phrase, r.count, r.jumpDepth])).toEqual([
      ["Moved", 3, 3],
      ["Resized", 1, 4],
      ["Deleted", 1, 5],
    ]);
  });

  it("offsets a collapsed future run by the current undo depth", () => {
    const undoDepth = 4;
    const labels = ["Move", "Move", "Move", "Resize"];
    const { future } = historyPanelRows([], labels, undoDepth);

    expect(future.map((r) => [r.phrase, r.count, r.jumpDepth])).toEqual([
      // Redoing the whole run of three lands at 4 + 3 = 7, not 4 + 1.
      ["Moved", 3, undoDepth + 3],
      ["Resized", 1, undoDepth + 4],
    ]);
  });

  it("collapses only CONSECUTIVE runs, so a repeat after a gap is its own row", () => {
    const labels = ["Move", "Move", "Resize", "Move"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past.map((r) => [r.phrase, r.count, r.jumpDepth])).toEqual([
      ["Moved", 2, 2],
      ["Resized", 1, 3],
      ["Moved", 1, 4],
    ]);
  });

  it("groups distinct labels that share one phrase, and still lands correctly", () => {
    // "Edit text" and "Set text" both read "Edited text"; the user sees one
    // action, so the row must apply both.
    const labels = ["Edit text", "Set text"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past).toEqual([{ phrase: "Edited text", count: 2, jumpDepth: 2 }]);
  });

  it("never yields a jump depth outside the real history range", () => {
    const pastLabels = ["Move", "Move", "Add object"];
    const futureLabels = ["Resize", "Resize"];
    const model = historyPanelRows(pastLabels, futureLabels, pastLabels.length);
    const total = pastLabels.length + futureLabels.length;

    for (const row of [...model.past, ...model.future]) {
      expect(row.jumpDepth).toBeGreaterThanOrEqual(1);
      expect(row.jumpDepth).toBeLessThanOrEqual(total);
    }
    // The last future row must reach the very end of the redo stack.
    expect(model.future[model.future.length - 1].jumpDepth).toBe(total);
  });

  it("covers every raw entry exactly once across the past rows", () => {
    const labels = ["Move", "Move", "Resize", "Delete", "Delete", "Delete"];
    const { past } = historyPanelRows(labels, [], labels.length);

    expect(past.reduce((sum, r) => sum + r.count, 0)).toBe(labels.length);
    // Depths are strictly increasing and the last one is the full depth.
    const depths = past.map((r) => r.jumpDepth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(new Set(depths).size).toBe(depths.length);
    expect(depths[depths.length - 1]).toBe(labels.length);
  });
});

describe("historyPanelRows — product language", () => {
  it("uses past-tense phrases rather than the raw command labels", () => {
    const { past } = historyPanelRows(["Move", "Resize", "Rotate", "Bring forward"], [], 4);
    expect(past.map((r) => r.phrase)).toEqual(["Moved", "Resized", "Rotated", "Brought forward"]);
  });

  it("does not invent a subject the panel cannot know", () => {
    // The history exposes labels only, so "Add object" degrades honestly.
    const { past } = historyPanelRows(["Add object"], [], 1);
    expect(past[0].phrase).toBe("Added object");
  });

  it("passes an unmapped label through unchanged instead of mangling it", () => {
    const { past } = historyPanelRows(["Rotate page", "Opacity"], [], 2);
    expect(past.map((r) => r.phrase)).toEqual(["Rotate page", "Opacity"]);
  });
});

describe("rowAccessibleName", () => {
  const single: HistoryPanelRow = { phrase: "Moved", count: 1, jumpDepth: 3 };
  const run: HistoryPanelRow = { phrase: "Moved", count: 5, jumpDepth: 7 };

  it("spells the run out rather than leaving the × chip to a screen reader", () => {
    expect(rowAccessibleName(single, "past")).toBe("Jump to Moved");
    expect(rowAccessibleName(run, "past")).toBe("Jump to Moved (5 steps)");
    expect(rowAccessibleName(single, "future")).toBe("Redo to Moved");
    expect(rowAccessibleName(run, "future")).toBe("Redo to Moved (5 steps)");
  });
});
