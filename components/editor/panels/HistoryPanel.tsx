"use client";

import { RotateCcw, RotateCw } from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import {
  historyPanelRows,
  rowAccessibleName,
  type HistoryPanelRow,
} from "@/components/editor/panels/historyPanelRows";

/**
 * The History panel (Part 6). Shows the undo stack (the "past", oldest→newest),
 * a marker for the current state, and the redo stack (the "future", next-redo
 * first). Clicking any entry jumps history to that point via the facade's
 * `jumpTo(targetUndoDepth)` (Part 6: history navigation), which undoes/redoes
 * as many steps as needed in one notification. The undo/redo buttons mirror the
 * Edit menu.
 *
 * The rows themselves come from `historyPanelRows`, which speaks product
 * language ("Moved" rather than the raw `Command.label` "Move") and collapses a
 * run of identical entries into one line with a count. That is PRESENTATIONAL
 * only: a collapsed row's `jumpDepth` is the depth of the newest entry in the
 * run, which is the same depth the ungrouped list passed for that entry, so
 * history semantics are untouched (see `historyPanelRows.test.ts`).
 */
export function HistoryPanel() {
  const { actions, undoDepth, canUndo, canRedo, undoLabel, redoLabel } = useEditorContext();
  const { past, future, empty } = historyPanelRows(
    actions.undoLabels(),
    actions.redoLabels(),
    undoDepth,
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-editor-border px-2.5 py-2">
        <h2 className="text-[13px] font-semibold text-editor-text">History</h2>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded-control p-1 text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text disabled:opacity-30 disabled:hover:bg-transparent"
            onClick={() => actions.undo()}
            disabled={!canUndo}
            title={undoLabel ? `Undo ${undoLabel}` : "Undo"}
            aria-label="Undo"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            className="rounded-control p-1 text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text disabled:opacity-30 disabled:hover:bg-transparent"
            onClick={() => actions.redo()}
            disabled={!canRedo}
            title={redoLabel ? `Redo ${redoLabel}` : "Redo"}
            aria-label="Redo"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-2">
        {empty ? (
          <p className="px-1.5 py-1 text-[12px] leading-5 text-editor-muted">No history yet.</p>
        ) : null}
        <ol className="space-y-px">
          {past.map((row, i) => (
            <li key={`p${i}`}>
              <HistoryRowButton
                row={row}
                direction="past"
                onClick={() => actions.jumpTo(row.jumpDepth)}
              />
            </li>
          ))}
          <li>
            <div
              className="flex min-h-7 w-full items-center gap-1.5 rounded-control bg-editor-accentsoft px-2 text-left text-[12px] font-semibold text-editor-accent"
              aria-current="true"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-editor-accent" aria-hidden />
              Current
            </div>
          </li>
          {future.map((row, j) => (
            <li key={`f${j}`}>
              <HistoryRowButton
                row={row}
                direction="future"
                onClick={() => actions.jumpTo(row.jumpDepth)}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * One history row. Future rows are dimmed because they describe a state the
 * document is not in — the same distinction the redo stack itself makes.
 */
function HistoryRowButton({
  row,
  direction,
  onClick,
}: {
  row: HistoryPanelRow;
  direction: "past" | "future";
  onClick: () => void;
}) {
  const accessibleName = rowAccessibleName(row, direction);
  return (
    <button
      className={`flex min-h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-[12px] transition-colors hover:bg-editor-subtle hover:text-editor-text ${
        direction === "past" ? "text-editor-text/85" : "text-editor-muted/75"
      }`}
      onClick={onClick}
      title={accessibleName}
      aria-label={accessibleName}
    >
      <span className="min-w-0 flex-1 truncate">{row.phrase}</span>
      {row.count > 1 ? (
        <span
          className="shrink-0 rounded-full bg-editor-subtle px-1.5 text-[10px] font-semibold tabular-nums text-editor-muted ring-1 ring-inset ring-editor-border"
          aria-hidden
        >
          ×{row.count}
        </span>
      ) : null}
    </button>
  );
}
