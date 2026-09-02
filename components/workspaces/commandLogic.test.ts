import { describe, expect, it } from "vitest";
import {
  EMPTY_OPERATIONS_TEXT,
  activeDescendantId,
  boundSelection,
  boundedOperationsForDisplay,
  buildCommandContext,
  canCancel,
  canExecuteCommand,
  canOpenResult,
  canRetry,
  categoryLabel,
  commandOptionId,
  disabledReasonText,
  emptyCommandStateText,
  flattenCommandGroups,
  groupCommandsForDisplay,
  isCurrentResponse,
  isQueryWithinBounds,
  mergeOperations,
  normalizeCommandQuery,
  operationAnnouncement,
  operationLabel,
  resetSelectionForResults,
  resolveCommandKey,
  shortcutLabel,
  showsOperationProgress,
  sortOperationsForDisplay,
  type CommandView,
  type OperationView,
} from "./commandLogic";
import { COMMAND_LIMITS } from "@/src/domain/entities/CommandPalette";

function command(overrides: Partial<CommandView> = {}): CommandView {
  return {
    id: "doc.save",
    label: "Save document",
    category: "document",
    shortcut: "Ctrl+S",
    enabled: true,
    disabledReason: null,
    ...overrides,
  };
}

function operation(overrides: Partial<OperationView> = {}): OperationView {
  return {
    id: "op-1",
    type: "export",
    documentId: "doc-1",
    label: "Exporting report",
    status: "running",
    progress: 40,
    error: null,
    hasResult: false,
    createdAt: "2026-08-04T09:00:00.000Z",
    updatedAt: "2026-08-04T09:01:00.000Z",
    ...overrides,
  };
}

describe("commandLogic — query handling", () => {
  it("normalizes a typed query", () => {
    expect(normalizeCommandQuery("  SaVe  ")).toBe("save");
  });

  it("caps a very long query before it reaches the matcher", () => {
    const long = "x".repeat(COMMAND_LIMITS.maxQueryLength + 500);
    expect(normalizeCommandQuery(long)).toHaveLength(COMMAND_LIMITS.maxQueryLength);
    expect(isQueryWithinBounds(long)).toBe(false);
    expect(isQueryWithinBounds("save")).toBe(true);
  });

  it("describes the empty state differently before and after typing", () => {
    expect(emptyCommandStateText("")).toContain("Start typing");
    expect(emptyCommandStateText("zzz")).toContain('"zzz"');
  });
});

describe("commandLogic — context", () => {
  it("derives hasDocument from the active document", () => {
    const withDoc = buildCommandContext({
      activeDocumentId: "doc-1",
      hasSelection: false,
      canWrite: true,
      isSplit: false,
      activePane: "left",
    });
    expect(withDoc.hasDocument).toBe(true);
    expect(withDoc.activeDocumentId).toBe("doc-1");

    const withoutDoc = buildCommandContext({
      activeDocumentId: null,
      hasSelection: false,
      canWrite: true,
      isSplit: false,
      activePane: "left",
    });
    expect(withoutDoc.hasDocument).toBe(false);
  });

  it("carries the active pane so a command targets the focused editor", () => {
    const context = buildCommandContext({
      activeDocumentId: "doc-1",
      hasSelection: false,
      canWrite: false,
      isSplit: true,
      activePane: "right",
    });
    expect(context.activePane).toBe("right");
    expect(context.isSplit).toBe(true);
  });

  it("carries the write permission it was given", () => {
    expect(
      buildCommandContext({
        activeDocumentId: "doc-1",
        hasSelection: false,
        canWrite: false,
        isSplit: false,
        activePane: "left",
      }).canWrite,
    ).toBe(false);
  });
});

describe("commandLogic — grouping and labels", () => {
  it("groups into a fixed category order", () => {
    // Fixed rather than by best match, so the palette's shape does not
    // rearrange between keystrokes.
    const groups = groupCommandsForDisplay([
      command({ id: "workspace.upload", category: "workspace" }),
      command({ id: "nav.back", category: "navigation" }),
      command({ id: "doc.save", category: "document" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual([
      "document",
      "navigation",
      "workspace",
    ]);
    expect(groups[0].label).toBe("Document");
  });

  it("omits categories with no results", () => {
    const groups = groupCommandsForDisplay([command()]);
    expect(groups).toHaveLength(1);
  });

  it("flattens groups into the rendered order", () => {
    const groups = groupCommandsForDisplay([
      command({ id: "nav.back", category: "navigation" }),
      command({ id: "doc.save", category: "document" }),
    ]);
    expect(flattenCommandGroups(groups).map((c) => c.id)).toEqual(["doc.save", "nav.back"]);
  });

  it("labels every category", () => {
    expect(categoryLabel("collaboration")).toBe("Collaboration");
    expect(categoryLabel("view")).toBe("View");
  });

  it("shows a shortcut only when there is one", () => {
    expect(shortcutLabel(command())).toBe("Ctrl+S");
    expect(shortcutLabel(command({ shortcut: null }))).toBeNull();
    expect(shortcutLabel(command({ shortcut: "   " }))).toBeNull();
  });
});

describe("commandLogic — disabled commands", () => {
  it("does not let a disabled command execute", () => {
    expect(canExecuteCommand(command())).toBe(true);
    expect(canExecuteCommand(command({ enabled: false }))).toBe(false);
  });

  it("explains why a command is unavailable", () => {
    expect(disabledReasonText(command())).toBeNull();
    expect(
      disabledReasonText(command({ enabled: false, disabledReason: "Open a document first." })),
    ).toBe("Open a document first.");
  });

  it("falls back to a usable reason when none was given", () => {
    // A greyed-out row with no explanation reads as broken.
    expect(disabledReasonText(command({ enabled: false, disabledReason: null }))).toContain(
      "not available",
    );
  });
});

describe("commandLogic — keyboard", () => {
  const list = [
    command({ id: "a" }),
    command({ id: "b", enabled: false, disabledReason: "Open a document first." }),
    command({ id: "c" }),
  ];

  it("moves down and wraps", () => {
    expect(resolveCommandKey("ArrowDown", 0, list)).toEqual({ kind: "move", index: 1 });
    expect(resolveCommandKey("ArrowDown", 2, list)).toEqual({ kind: "move", index: 0 });
  });

  it("moves up and wraps", () => {
    expect(resolveCommandKey("ArrowUp", 1, list)).toEqual({ kind: "move", index: 0 });
    expect(resolveCommandKey("ArrowUp", 0, list)).toEqual({ kind: "move", index: 2 });
  });

  it("does not skip a disabled row", () => {
    // The reason is the useful part; skipping past it silently would hide it
    // from a keyboard user entirely.
    expect(resolveCommandKey("ArrowDown", 0, list)).toEqual({ kind: "move", index: 1 });
  });

  it("jumps to the first and last rows", () => {
    expect(resolveCommandKey("Home", 2, list)).toEqual({ kind: "move", index: 0 });
    expect(resolveCommandKey("End", 0, list)).toEqual({ kind: "move", index: 2 });
  });

  it("ignores Home and End with no results", () => {
    expect(resolveCommandKey("Home", -1, [])).toEqual({ kind: "ignore" });
    expect(resolveCommandKey("End", -1, [])).toEqual({ kind: "ignore" });
  });

  it("executes the highlighted command on Enter", () => {
    expect(resolveCommandKey("Enter", 0, list)).toEqual({ kind: "execute", index: 0 });
  });

  it("refuses Enter on a disabled command", () => {
    // The keyboard path must not be able to run what the pointer path greys out.
    expect(resolveCommandKey("Enter", 1, list)).toEqual({ kind: "ignore" });
  });

  it("ignores Enter with nothing highlighted", () => {
    expect(resolveCommandKey("Enter", -1, list)).toEqual({ kind: "ignore" });
    expect(resolveCommandKey("Enter", 0, [])).toEqual({ kind: "ignore" });
  });

  it("closes on Escape", () => {
    expect(resolveCommandKey("Escape", 0, list)).toEqual({ kind: "close" });
  });

  it("ignores keys it does not handle", () => {
    expect(resolveCommandKey("Tab", 0, list)).toEqual({ kind: "ignore" });
  });
});

describe("commandLogic — selection bounds", () => {
  it("resets to the first row when the query changes", () => {
    // A stale index points at whatever now occupies that position, which is how
    // a user runs a command they never read.
    expect(resetSelectionForResults(3)).toBe(0);
    expect(resetSelectionForResults(0)).toBe(-1);
  });

  it("keeps the selection inside the list", () => {
    expect(boundSelection(9, 3)).toBe(2);
    expect(boundSelection(-4, 3)).toBe(0);
    expect(boundSelection(1, 0)).toBe(-1);
  });

  it("points active-descendant at the highlighted row", () => {
    const list = [command({ id: "a" }), command({ id: "b" })];
    expect(activeDescendantId("palette", 1, list)).toBe("palette-command-b");
    expect(activeDescendantId("palette", -1, list)).toBeNull();
    expect(activeDescendantId("palette", 5, list)).toBeNull();
  });

  it("agrees with the rendered row id", () => {
    expect(commandOptionId("palette", "b")).toBe(activeDescendantId("palette", 0, [command({ id: "b" })]));
  });
});

describe("commandLogic — operation display", () => {
  it("puts active work first, then most recent", () => {
    const sorted = sortOperationsForDisplay([
      operation({ id: "done", status: "completed", updatedAt: "2026-08-04T10:00:00.000Z" }),
      operation({ id: "running", status: "running", updatedAt: "2026-08-04T09:00:00.000Z" }),
      operation({ id: "older-done", status: "failed", updatedAt: "2026-08-04T08:00:00.000Z" }),
    ]);
    // The running job is what the user is waiting on, so a strictly
    // chronological list would bury it.
    expect(sorted.map((o) => o.id)).toEqual(["running", "done", "older-done"]);
  });

  it("bounds what is rendered", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      operation({ id: `op-${index}`, status: "completed" }),
    );
    expect(boundedOperationsForDisplay(many)).toHaveLength(COMMAND_LIMITS.maxOperationHistory);
    expect(boundedOperationsForDisplay(many, 5)).toHaveLength(5);
  });

  it("announces an accessible status label", () => {
    expect(operationLabel(operation({ status: "running", progress: 40 }))).toBe(
      "Exporting report: 40% complete",
    );
    expect(operationLabel(operation({ status: "pending" }))).toContain("waiting to start");
  });

  it("shows a determinate progress bar only while running", () => {
    expect(showsOperationProgress(operation({ status: "running" }))).toBe(true);
    expect(showsOperationProgress(operation({ status: "pending" }))).toBe(false);
    expect(showsOperationProgress(operation({ status: "completed" }))).toBe(false);
  });

  it("offers a result only when the operation completed and has one", () => {
    expect(canOpenResult(operation({ status: "completed", hasResult: true }))).toBe(true);
    // An interrupted worker produces exactly this: a link here opens nothing.
    expect(canOpenResult(operation({ status: "completed", hasResult: false }))).toBe(false);
    expect(canOpenResult(operation({ status: "running", hasResult: true }))).toBe(false);
  });

  it("offers cancel only while the operation is active", () => {
    expect(canCancel(operation({ status: "pending" }))).toBe(true);
    expect(canCancel(operation({ status: "running" }))).toBe(true);
    expect(canCancel(operation({ status: "completed" }))).toBe(false);
    expect(canCancel(operation({ status: "cancelled" }))).toBe(false);
  });

  it("offers retry only for work that failed or was cancelled", () => {
    expect(canRetry(operation({ status: "failed" }))).toBe(true);
    expect(canRetry(operation({ status: "cancelled" }))).toBe(true);
    expect(canRetry(operation({ status: "running" }))).toBe(false);
    expect(canRetry(operation({ status: "completed" }))).toBe(false);
  });

  it("announces terminal outcomes including the error", () => {
    expect(operationAnnouncement(operation({ status: "completed" }))).toContain("completed");
    expect(
      operationAnnouncement(operation({ status: "failed", error: "Network unavailable." })),
    ).toContain("Network unavailable.");
    expect(operationAnnouncement(operation({ status: "cancelled" }))).toContain("cancelled");
  });

  it("names the empty state", () => {
    expect(EMPTY_OPERATIONS_TEXT).toContain("No recent operations");
  });
});

describe("commandLogic — response handling", () => {
  it("suppresses a stale response", () => {
    // A slow first request landing after a fast second one would otherwise
    // overwrite current state with old data.
    expect(isCurrentResponse(2, 2)).toBe(true);
    expect(isCurrentResponse(1, 2)).toBe(false);
  });

  it("merges a fresh list over what is displayed", () => {
    const merged = mergeOperations(
      [operation({ id: "op-1", status: "running", progress: 20 })],
      [operation({ id: "op-1", status: "running", progress: 80 })],
    );
    expect(merged[0].progress).toBe(80);
  });

  it("never moves a finished operation back to running", () => {
    // Duplicate and reordered deliveries are normal with polling; one must not
    // make the panel claim work restarted.
    const merged = mergeOperations(
      [operation({ id: "op-1", status: "completed", hasResult: true })],
      [operation({ id: "op-1", status: "running", progress: 60 })],
    );
    expect(merged[0].status).toBe("completed");
    expect(merged[0].hasResult).toBe(true);
  });

  it("accepts a terminal update over a terminal state", () => {
    const merged = mergeOperations(
      [operation({ id: "op-1", status: "failed", error: "First." })],
      [operation({ id: "op-1", status: "failed", error: "Corrected." })],
    );
    expect(merged[0].error).toBe("Corrected.");
  });

  it("adds operations it has not seen", () => {
    const merged = mergeOperations(
      [operation({ id: "op-1", status: "completed" })],
      [operation({ id: "op-2", status: "running" })],
    );
    expect(merged.map((o) => o.id)).toEqual(["op-2", "op-1"]);
  });
});
