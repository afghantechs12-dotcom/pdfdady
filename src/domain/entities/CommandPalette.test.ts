import { describe, expect, it } from "vitest";
import {
  COMMAND_LIMITS,
  boundOperationError,
  canCancelOperation,
  canOpenOperationResult,
  canRetryOperation,
  canTransitionOperation,
  evaluateCommand,
  groupByCategory,
  isOperationStatus,
  isTerminalOperationStatus,
  isValidCommand,
  moveSelection,
  operationProgress,
  operationStatusLabel,
  scoreCommand,
  searchCommands,
  sortOperations,
  trimOperationHistory,
  validateOperationProgress,
  type CommandContext,
  type CommandDescriptor,
  type OperationStatus,
} from "./CommandPalette";

function command(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    id: "doc.save",
    label: "Save",
    keywords: ["store", "persist"],
    category: "document",
    shortcut: "Ctrl+S",
    ...overrides,
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    hasDocument: true,
    hasSelection: true,
    canWrite: true,
    isSplit: true,
    activePane: "left",
    activeDocumentId: "doc-1",
    ...overrides,
  };
}

const COMMANDS: CommandDescriptor[] = [
  command({ id: "doc.save", label: "Save", keywords: ["store"] }),
  command({ id: "doc.saveAs", label: "Save a copy", keywords: ["duplicate"] }),
  command({ id: "view.split", label: "Split view", keywords: ["pane", "side by side"], category: "view" }),
  command({ id: "nav.goto", label: "Go to page", keywords: ["jump"], category: "navigation" }),
  command({
    id: "collab.comment",
    label: "Add comment",
    keywords: ["annotate", "note"],
    category: "collaboration",
  }),
];

describe("command validation", () => {
  it("accepts a well-formed descriptor", () => {
    expect(isValidCommand(command())).toBe(true);
  });

  it("rejects a descriptor missing identity or label", () => {
    expect(isValidCommand({ ...command(), id: "" })).toBe(false);
    expect(isValidCommand({ ...command(), label: "   " })).toBe(false);
  });

  it("rejects an unknown category", () => {
    expect(isValidCommand({ ...command(), category: "telepathy" })).toBe(false);
  });

  it("rejects over-long and over-many fields", () => {
    expect(isValidCommand({ ...command(), id: "x".repeat(COMMAND_LIMITS.maxIdLength + 1) })).toBe(
      false,
    );
    expect(
      isValidCommand({
        ...command(),
        keywords: Array.from({ length: COMMAND_LIMITS.maxKeywords + 1 }, () => "k"),
      }),
    ).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isValidCommand(null)).toBe(false);
    expect(isValidCommand("save")).toBe(false);
  });
});

describe("contextual enablement", () => {
  it("enables a command whose requirements are met", () => {
    const evaluated = evaluateCommand(command({ requirements: { document: true } }), context());
    expect(evaluated.enabled).toBe(true);
    expect(evaluated.disabledReason).toBeNull();
  });

  it("explains why a command needing a document is unavailable", () => {
    // A greyed-out command with no reason reads as broken.
    const evaluated = evaluateCommand(
      command({ requirements: { document: true } }),
      context({ hasDocument: false }),
    );
    expect(evaluated.enabled).toBe(false);
    expect(evaluated.disabledReason).toBe("Open a document first.");
  });

  it("explains a missing selection", () => {
    const evaluated = evaluateCommand(
      command({ requirements: { selection: true } }),
      context({ hasSelection: false }),
    );
    expect(evaluated.disabledReason).toBe("Select something first.");
  });

  it("explains missing write permission", () => {
    const evaluated = evaluateCommand(
      command({ requirements: { write: true } }),
      context({ canWrite: false }),
    );
    expect(evaluated.enabled).toBe(false);
    expect(evaluated.disabledReason).toContain("permission");
  });

  it("explains a missing split layout", () => {
    const evaluated = evaluateCommand(
      command({ requirements: { split: true } }),
      context({ isSplit: false }),
    );
    expect(evaluated.disabledReason).toBe("Open split view first.");
  });

  it("enables a command with no requirements regardless of context", () => {
    const evaluated = evaluateCommand(
      command({ requirements: undefined }),
      context({ hasDocument: false, canWrite: false, hasSelection: false, isSplit: false }),
    );
    expect(evaluated.enabled).toBe(true);
  });
});

describe("command search", () => {
  it("ranks an exact label match first", () => {
    const results = searchCommands(COMMANDS, "Save", context());
    expect(results[0].id).toBe("doc.save");
  });

  it("prefers a prefix over a later substring", () => {
    // A user typing "sav" expects "Save" before anything merely containing it.
    const results = searchCommands(COMMANDS, "sav", context());
    expect(results[0].id).toBe("doc.save");
    expect(results.map((r) => r.id)).toContain("doc.saveAs");
  });

  it("matches on keywords", () => {
    const results = searchCommands(COMMANDS, "annotate", context());
    expect(results[0].id).toBe("collab.comment");
  });

  it("matches a subsequence as a last resort", () => {
    const results = searchCommands(COMMANDS, "spl", context());
    expect(results.map((r) => r.id)).toContain("view.split");
  });

  it("returns everything for an empty query", () => {
    const results = searchCommands(COMMANDS, "", context());
    expect(results).toHaveLength(COMMANDS.length);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchCommands(COMMANDS, "zzzzqqq", context())).toHaveLength(0);
  });

  it("refuses an over-long query rather than scanning it", () => {
    const long = "a".repeat(COMMAND_LIMITS.maxQueryLength + 1);
    expect(searchCommands(COMMANDS, long, context())).toHaveLength(0);
  });

  it("bounds the number of results", () => {
    const many = Array.from({ length: COMMAND_LIMITS.maxResults + 20 }, (_, i) =>
      command({ id: `cmd.${i}`, label: `Command ${i}` }),
    );
    expect(searchCommands(many, "command", context())).toHaveLength(COMMAND_LIMITS.maxResults);
  });

  it("includes disabled commands with their reason rather than hiding them", () => {
    // Hiding a command a user knows exists reads as the feature being removed.
    const commands = [command({ id: "doc.save", label: "Save", requirements: { write: true } })];
    const results = searchCommands(commands, "save", context({ canWrite: false }));

    expect(results).toHaveLength(1);
    expect(results[0].enabled).toBe(false);
    expect(results[0].disabledReason).toContain("permission");
  });

  it("scores deterministically for the same input", () => {
    const first = searchCommands(COMMANDS, "s", context()).map((r) => r.id);
    const second = searchCommands(COMMANDS, "s", context()).map((r) => r.id);
    expect(first).toEqual(second);
  });

  it("returns null from scoreCommand for a non-match", () => {
    expect(scoreCommand(command({ label: "Save", keywords: [] }), "qqqq")).toBeNull();
  });

  it("groups results by category preserving rank", () => {
    const groups = groupByCategory(searchCommands(COMMANDS, "", context()));
    expect(groups.some((g) => g.category === "document")).toBe(true);
    expect(groups.find((g) => g.category === "document")?.commands.length).toBe(2);
  });
});

describe("keyboard selection", () => {
  it("wraps at both ends", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
  });

  it("starts at either end depending on direction", () => {
    expect(moveSelection(-1, 1, 3)).toBe(0);
    expect(moveSelection(-1, -1, 3)).toBe(2);
  });

  it("has no selection in an empty list", () => {
    expect(moveSelection(0, 1, 0)).toBe(-1);
  });
});

describe("operation state machine", () => {
  it("validates a status", () => {
    expect(isOperationStatus("running")).toBe(true);
    expect(isOperationStatus("levitating")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminalOperationStatus("completed")).toBe(true);
    expect(isTerminalOperationStatus("failed")).toBe(true);
    expect(isTerminalOperationStatus("cancelled")).toBe(true);
    expect(isTerminalOperationStatus("running")).toBe(false);
  });

  it("permits only forward transitions", () => {
    expect(canTransitionOperation("pending", "running")).toBe(true);
    expect(canTransitionOperation("running", "completed")).toBe(true);
    expect(canTransitionOperation("pending", "completed")).toBe(false);
  });

  it("gives terminal states no outgoing edges", () => {
    // A late worker must not resurrect an operation the user saw finish.
    for (const terminal of ["completed", "failed", "cancelled"] as OperationStatus[]) {
      for (const target of ["running", "completed", "failed", "cancelled"] as OperationStatus[]) {
        expect(canTransitionOperation(terminal, target)).toBe(false);
      }
    }
  });

  it("reconciles progress with status", () => {
    expect(operationProgress("completed", 60)).toBe(100);
    expect(operationProgress("pending", 60)).toBe(0);
    expect(operationProgress("running", 60)).toBe(60);
    expect(operationProgress("running", Number.NaN)).toBe(0);
    expect(operationProgress("running", 140)).toBe(100);
  });

  it("validates a progress report", () => {
    expect(validateOperationProgress(50)).toBe(50);
    expect(validateOperationProgress(-1)).toBeNull();
    expect(validateOperationProgress(101)).toBeNull();
    expect(validateOperationProgress("50")).toBeNull();
  });

  it("bounds an operation error", () => {
    expect(boundOperationError("  broke  ")).toBe("broke");
    expect(boundOperationError("")).toBeNull();
    expect(boundOperationError(null)).toBeNull();
    expect([...(boundOperationError("x".repeat(2000)) ?? "")].length).toBe(
      COMMAND_LIMITS.maxErrorLength,
    );
  });
});

describe("operation controls", () => {
  it("offers cancel only while active", () => {
    expect(canCancelOperation({ status: "pending" })).toBe(true);
    expect(canCancelOperation({ status: "running" })).toBe(true);
    expect(canCancelOperation({ status: "completed" })).toBe(false);
  });

  it("offers retry only after a failure or cancellation", () => {
    expect(canRetryOperation({ status: "failed" })).toBe(true);
    expect(canRetryOperation({ status: "cancelled" })).toBe(true);
    expect(canRetryOperation({ status: "completed" })).toBe(false);
    expect(canRetryOperation({ status: "running" })).toBe(false);
  });

  it("offers a result only when one actually exists", () => {
    // A completed operation with nothing attached would open an empty result.
    expect(canOpenOperationResult({ status: "completed", resultRef: "res-1" })).toBe(true);
    expect(canOpenOperationResult({ status: "completed", resultRef: null })).toBe(false);
    expect(canOpenOperationResult({ status: "running", resultRef: "res-1" })).toBe(false);
  });

  it("announces status accessibly", () => {
    expect(operationStatusLabel({ status: "running", progress: 40, label: "Comparison" })).toBe(
      "Comparison: 40% complete",
    );
    expect(operationStatusLabel({ status: "failed", progress: 0, label: "Export" })).toBe(
      "Export: failed",
    );
  });
});

describe("operation ordering and history", () => {
  function op(id: string, status: OperationStatus, minutes: number) {
    return { id, status, updatedAt: new Date(Date.UTC(2026, 7, 4, 12, minutes)) };
  }

  it("puts active work before finished work", () => {
    const sorted = sortOperations([
      op("done", "completed", 10),
      op("active", "running", 1),
      op("failed", "failed", 20),
    ]);
    expect(sorted[0].id).toBe("active");
  });

  it("orders finished work most recent first", () => {
    const sorted = sortOperations([op("old", "completed", 1), op("new", "completed", 30)]);
    expect(sorted.map((o) => o.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the array it was given", () => {
    const list = [op("a", "completed", 1), op("b", "running", 2)];
    sortOperations(list);
    expect(list[0].id).toBe("a");
  });

  it("bounds retained history without dropping active work", () => {
    const many = [
      op("active", "running", 0),
      ...Array.from({ length: COMMAND_LIMITS.maxOperationHistory + 20 }, (_, i) =>
        op(`done-${i}`, "completed", i + 1),
      ),
    ];
    const trimmed = trimOperationHistory(many);

    expect(trimmed).toHaveLength(COMMAND_LIMITS.maxOperationHistory);
    // The part the user is waiting on survives.
    expect(trimmed.some((o) => o.id === "active")).toBe(true);
  });

  it("leaves a short history untouched", () => {
    const list = [op("a", "running", 1)];
    expect(trimOperationHistory(list)).toHaveLength(1);
  });
});
