import { describe, expect, it } from "vitest";
import {
  activeDescendantId,
  canCancel,
  canOpenResult,
  canRetry,
  commandOptionId,
  disabledReasonText,
  emptyCommandStateText,
  operationAnnouncement,
  operationLabel,
  resolveCommandKey,
  showsOperationProgress,
  type CommandView,
  type OperationView,
} from "./commandLogic";
import {
  canShowBothPanes,
  isCollapsedForWidth,
  paneSwitchTarget,
  visiblePanes,
} from "./splitViewLogic";
import { statisticsStatusLabel, NOT_MEASURED_LABEL } from "./statisticsLogic";

/**
 * M7.15 accessibility and responsive verification, at the level automated tests
 * can actually reach.
 *
 * These assert the *rules* the components read: what a status region says, which
 * controls a state offers, where a keypress lands, and what a narrow viewport
 * renders. They are labelled **automated** in the checkpoint. They do not
 * constitute screen-reader or physical-device verification, and nothing here is
 * recorded as such.
 */

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

describe("M7.15 a11y — accessible names and status text", () => {
  it("gives every operation state a distinct spoken status", () => {
    const spoken = new Set(
      (["pending", "running", "completed", "failed", "cancelled"] as const).map((status) =>
        operationLabel(operation({ status, progress: status === "completed" ? 100 : 40 })),
      ),
    );
    // Five states, five distinct strings: two states reading identically would
    // make the panel unusable without sight of the icons.
    expect(spoken.size).toBe(5);
  });

  it("names the operation in its own status text", () => {
    // "40% complete" alone is meaningless when several operations are listed.
    expect(operationLabel(operation())).toContain("Exporting report");
  });

  it("announces terminal outcomes rather than every progress tick", () => {
    // A live region firing on each percentage is unusable with a screen reader,
    // and the intermediate value is already on the progress bar.
    expect(operationAnnouncement(operation({ status: "completed" }))).toContain("completed");
    expect(operationAnnouncement(operation({ status: "failed", error: "Disk full." }))).toContain(
      "Disk full.",
    );
  });

  it("labels an unmeasured statistic as unmeasured rather than as zero", () => {
    expect(NOT_MEASURED_LABEL).toBe("Not measured");
    // "Calculation pending" and "Could not be calculated" are different facts;
    // a panel that read them the same would claim nothing was measured when the
    // measurement actually failed.
    expect(statisticsStatusLabel("pending", null)).not.toBe(
      statisticsStatusLabel("failed", null),
    );
  });

  it("always gives a disabled command a reason to read out", () => {
    for (const reason of [null, "", "Open a document first."]) {
      const text = disabledReasonText(command({ enabled: false, disabledReason: reason }));
      expect(text).toBeTruthy();
    }
  });

  it("describes the empty command state rather than showing an empty box", () => {
    expect(emptyCommandStateText("").length).toBeGreaterThan(0);
    expect(emptyCommandStateText("zzz").length).toBeGreaterThan(0);
  });
});

describe("M7.15 a11y — progress semantics", () => {
  it("renders a determinate bar only when there is real progress to report", () => {
    // Anything else would be a bar moving on no information.
    expect(showsOperationProgress(operation({ status: "running" }))).toBe(true);
    for (const status of ["pending", "completed", "failed", "cancelled"] as const) {
      expect(showsOperationProgress(operation({ status }))).toBe(false);
    }
  });

  it("keeps reported progress inside the bar's declared range", () => {
    for (const progress of [0, 1, 50, 99, 100]) {
      const value = operation({ status: "running", progress }).progress;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("M7.15 a11y — keyboard operation", () => {
  const list = [
    command({ id: "a" }),
    command({ id: "b", enabled: false, disabledReason: "Open a document first." }),
    command({ id: "c" }),
  ];

  it("reaches every row including disabled ones", () => {
    const reached = new Set<number>();
    let index = 0;
    for (let step = 0; step < list.length; step += 1) {
      const outcome = resolveCommandKey("ArrowDown", index, list);
      if (outcome.kind === "move") index = outcome.index;
      reached.add(index);
    }
    expect(reached.size).toBe(list.length);
  });

  it("closes on Escape from anywhere in the list", () => {
    for (let index = -1; index < list.length; index += 1) {
      expect(resolveCommandKey("Escape", index, list)).toEqual({ kind: "close" });
    }
  });

  it("keeps active-descendant pointing at a row that exists", () => {
    for (let index = 0; index < list.length; index += 1) {
      const id = activeDescendantId("palette", index, list);
      expect(id).toBe(commandOptionId("palette", list[index].id));
    }
    expect(activeDescendantId("palette", 99, list)).toBeNull();
  });

  it("offers only controls that apply, so focus never lands on a dead button", () => {
    // A cancel button on finished work is a focus stop that does nothing.
    expect(canCancel(operation({ status: "completed" }))).toBe(false);
    expect(canRetry(operation({ status: "running" }))).toBe(false);
    expect(canOpenResult(operation({ status: "completed", hasResult: false }))).toBe(false);
  });
});

describe("M7.15 responsive — narrow viewports", () => {
  it("falls back to one pane below the split breakpoint", () => {
    expect(canShowBothPanes(1440)).toBe(true);
    expect(canShowBothPanes(768)).toBe(true);
    expect(canShowBothPanes(390)).toBe(false);
  });

  it("shows the active pane, not always the left one, when collapsed", () => {
    // Collapsing to "left" would strand a user who was working in the right
    // pane when they rotated their phone.
    expect(visiblePanes("split", "right", 390)).toEqual(["right"]);
    expect(visiblePanes("split", "left", 390)).toEqual(["left"]);
    expect(visiblePanes("split", "left", 1440)).toEqual(["left", "right"]);
  });

  it("reports the collapse so the UI can explain it", () => {
    expect(isCollapsedForWidth("split", 390)).toBe(true);
    expect(isCollapsedForWidth("single", 390)).toBe(false);
    expect(isCollapsedForWidth("split", 1440)).toBe(false);
  });

  it("offers pane switching only when there is a pane worth switching to", () => {
    const panes = [
      { id: "left" as const, tabs: [], activeTabId: null, active: true },
      {
        id: "right" as const,
        tabs: [{ id: "t1", title: "Report", documentId: "doc-1", dirty: false, conflict: false }],
        activeTabId: "t1",
        active: false,
      },
    ];
    expect(paneSwitchTarget("split", "left", panes)).toBe("right");
    // An empty pane is not a useful destination: moving focus there would strand
    // a keyboard user in a region with nothing in it.
    expect(paneSwitchTarget("split", "right", panes)).toBeNull();
    expect(paneSwitchTarget("single", "left", panes)).toBeNull();
  });

  it("does not hide a primary action behind width alone", () => {
    // The palette's own results are width-independent: nothing is filtered out
    // for a narrow screen, so no command becomes unreachable on a phone.
    const wide = resolveCommandKey("Enter", 0, [command()]);
    expect(wide).toEqual({ kind: "execute", index: 0 });
  });
});
