import {
  groupHistoryRows,
  historyPhrase,
} from "@/src/application/editor/commands/historyLabels";

/**
 * The History panel's row model. PURE — no React, no DOM.
 *
 * WHY A SEPARATE MODULE. `historyLabels` already turns engineering labels into
 * product language and collapses repeated runs, but it speaks in history
 * DEPTHS. The panel needs `jumpTo` ARGUMENTS, and the two differ for the redo
 * stack (a future row's target is offset by the current undo depth). That
 * arithmetic is the one thing grouping could plausibly break, so it lives here
 * where a Node test can pin it — vitest collects `.test.ts` files only, so
 * logic that stays inside the `.tsx` component is untestable.
 *
 * PRESENTATION ONLY. Nothing here executes, merges, reorders or relabels a
 * command. A row's `jumpDepth` is exactly the depth the ungrouped panel passed
 * for the same entry, so what Undo does is unchanged — only what the UI calls
 * it, and how many lines it spends saying it.
 */

/** One visible row in the History panel. */
export interface HistoryPanelRow {
  /** Product-language text for the row ("Moved", "Added object"). */
  phrase: string;
  /** How many consecutive entries this row collapses (>= 1). */
  count: number;
  /**
   * The exact argument to pass to `actions.jumpTo`.
   *
   * For a collapsed run this is the depth of the NEWEST entry in the run: the
   * row presents the run as one action, so jumping to it must apply all of it.
   */
  jumpDepth: number;
}

/** The whole panel's rows, plus whether there is any history at all. */
export interface HistoryPanelModel {
  /** The undo stack, oldest → newest (rendered above the "Current" marker). */
  past: HistoryPanelRow[];
  /** The redo stack, next-redo first (rendered below the marker). */
  future: HistoryPanelRow[];
  /** True when both stacks are empty, so the panel shows its empty state. */
  empty: boolean;
}

/**
 * Builds the panel's rows from the facade's raw label stacks.
 *
 * `pastLabels` is `undoLabels()` (oldest → newest) and `futureLabels` is
 * `redoLabels()` (next-redo first) — the orders the command history already
 * exposes. `undoDepth` is the current depth, which is what shifts the redo
 * stack's jump targets.
 *
 * Only labels are available here: the history exposes `Command.label` strings
 * and nothing about the object a command acted on, so `historyPhrase` is used
 * in its subject-less form ("Moved", not "Moved image"). That degradation is
 * deliberate — inventing a subject the panel cannot know would be a lie about
 * what the undo step does.
 */
export function historyPanelRows(
  pastLabels: readonly string[],
  futureLabels: readonly string[],
  undoDepth: number,
): HistoryPanelModel {
  const past = groupHistoryRows(pastLabels.map((label) => historyPhrase(label))).map((row) => ({
    phrase: row.phrase,
    count: row.count,
    jumpDepth: row.depth,
  }));

  const future = groupHistoryRows(futureLabels.map((label) => historyPhrase(label))).map((row) => ({
    phrase: row.phrase,
    count: row.count,
    // `redoLabels()` is next-redo first, so index j is j+1 steps forward from
    // the current depth. A collapsed run redoes through its newest member.
    jumpDepth: undoDepth + row.depth,
  }));

  return { past, future, empty: pastLabels.length === 0 && futureLabels.length === 0 };
}

/**
 * The accessible name for a row's button.
 *
 * The row shows a collapsed run's size as a `×5` chip, which a screen reader
 * renders as "times 5", so the chip is hidden and the name spells the run out.
 */
export function rowAccessibleName(row: HistoryPanelRow, direction: "past" | "future"): string {
  const verb = direction === "past" ? "Jump to" : "Redo to";
  return row.count > 1
    ? `${verb} ${row.phrase} (${row.count} steps)`
    : `${verb} ${row.phrase}`;
}
