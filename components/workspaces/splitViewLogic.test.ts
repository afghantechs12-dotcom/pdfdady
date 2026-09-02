import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_ENTRIES,
  SPLIT_MIN_WIDTH,
  canOpenSplit,
  canShowBothPanes,
  canSynchronize,
  describeHistoryEntry,
  describeSplitViewError,
  historyControls,
  isActivationKey,
  isCollapsedForWidth,
  isPaneSwitchShortcut,
  paneAnnouncement,
  paneLabel,
  paneSwitchLabel,
  paneSwitchTarget,
  paneTabLabel,
  readPaneId,
  splitToggleLabel,
  syncModeLabel,
  syncOptions,
  visiblePanes,
  type PaneViewModel,
} from "./splitViewLogic";
import { SPLIT_VIEW_LIMITS, emptyHistory, pushHistory } from "@/src/domain/entities/SplitView";

function pane(id: "left" | "right", tabCount: number, active = false): PaneViewModel {
  return {
    id,
    tabs: Array.from({ length: tabCount }, (_, i) => ({
      id: `${id}-tab-${i}`,
      title: `Doc ${i}`,
      documentId: `doc-${i}`,
      dirty: false,
      conflict: false,
    })),
    activeTabId: tabCount > 0 ? `${id}-tab-0` : null,
    active,
  };
}

describe("responsive layout", () => {
  it("shows both panes only when there is room", () => {
    expect(canShowBothPanes(SPLIT_MIN_WIDTH)).toBe(true);
    expect(canShowBothPanes(SPLIT_MIN_WIDTH - 1)).toBe(false);
  });

  it("renders one pane in a single-pane layout regardless of width", () => {
    expect(visiblePanes("single", "left", 1920)).toEqual(["left"]);
  });

  it("renders both panes when split and wide", () => {
    expect(visiblePanes("split", "left", 1440)).toEqual(["left", "right"]);
  });

  it("falls back to the active pane on a narrow screen", () => {
    // The assignment is untouched — only what is rendered changes — so
    // widening the window restores the arrangement.
    expect(visiblePanes("split", "right", 480)).toEqual(["right"]);
    expect(isCollapsedForWidth("split", 480)).toBe(true);
    expect(isCollapsedForWidth("single", 480)).toBe(false);
  });
});

describe("labels", () => {
  it("names panes only when there is more than one", () => {
    expect(paneLabel("left", "single")).toBe("Document");
    expect(paneLabel("left", "split")).toBe("Left pane");
    expect(paneLabel("right", "split")).toBe("Right pane");
  });

  it("carries unsaved and conflict state into the tab label", () => {
    expect(
      paneTabLabel({ id: "t", title: "Report", documentId: "d", dirty: true, conflict: false }),
    ).toBe("Report, unsaved changes");
    expect(
      paneTabLabel({ id: "t", title: "Report", documentId: "d", dirty: true, conflict: true }),
    ).toContain("version conflict");
  });

  it("names an untitled document rather than rendering an empty label", () => {
    expect(
      paneTabLabel({ id: "t", title: "", documentId: "d", dirty: false, conflict: false }),
    ).toBe("Untitled document");
  });

  it("announces the focused pane", () => {
    expect(paneAnnouncement("right", "split")).toBe("Right pane focused.");
    expect(paneAnnouncement("left", "single")).toBe("Single pane view.");
  });
});

describe("pane switching", () => {
  it("has no target in a single-pane layout", () => {
    expect(paneSwitchTarget("single", "left", [pane("left", 2, true)])).toBeNull();
  });

  it("targets the other pane when it holds something", () => {
    const panes = [pane("left", 1, true), pane("right", 1)];
    expect(paneSwitchTarget("split", "left", panes)).toBe("right");
    expect(paneSwitchTarget("split", "right", panes)).toBe("left");
  });

  it("has no target when the other pane is empty", () => {
    const panes = [pane("left", 1, true), pane("right", 0)];
    expect(paneSwitchTarget("split", "left", panes)).toBeNull();
  });

  it("labels the switch control by destination", () => {
    expect(paneSwitchLabel("right")).toBe("Switch to right pane");
    expect(paneSwitchLabel("left")).toBe("Switch to left pane");
    expect(paneSwitchLabel(null)).toBe("Switch pane");
  });

  it("recognizes Alt+Arrow as the pane shortcut", () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false };
    expect(isPaneSwitchShortcut({ ...base, key: "ArrowLeft" })).toBe("left");
    expect(isPaneSwitchShortcut({ ...base, key: "ArrowRight" })).toBe("right");
  });

  it("ignores the shortcut when a platform modifier is held", () => {
    // A shortcut that fights the browser or the editor is one nobody can rely on.
    expect(
      isPaneSwitchShortcut({ key: "ArrowLeft", altKey: true, ctrlKey: true, metaKey: false }),
    ).toBeNull();
    expect(
      isPaneSwitchShortcut({ key: "ArrowLeft", altKey: false, ctrlKey: false, metaKey: false }),
    ).toBeNull();
  });

  it("recognizes activation keys for non-button controls", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("a")).toBe(false);
  });
});

describe("synchronization options", () => {
  it("offers every mode with a description", () => {
    const options = syncOptions();
    expect(options.map((o) => o.value)).toEqual(["off", "page", "scroll", "zoom", "all"]);
    expect(options.every((o) => o.description.length > 0)).toBe(true);
  });

  it("labels the current mode", () => {
    expect(syncModeLabel("off")).toBe("Independent");
    expect(syncModeLabel("all")).toBe("Fully linked");
  });

  it("offers synchronization only when there are two panes", () => {
    // Nothing to keep in step with in a single-pane layout.
    expect(canSynchronize("split")).toBe(true);
    expect(canSynchronize("single")).toBe(false);
  });
});

describe("split toggle", () => {
  it("labels the toggle by what it would do", () => {
    expect(splitToggleLabel("single")).toBe("Open split view");
    expect(splitToggleLabel("split")).toBe("Close split view");
  });

  it("requires two documents before splitting", () => {
    // Splitting with one would put the same tab in both halves.
    expect(canOpenSplit(1)).toBe(false);
    expect(canOpenSplit(2)).toBe(true);
  });
});

describe("history controls", () => {
  it("disables both directions on an empty history", () => {
    const controls = historyControls(emptyHistory());
    expect(controls.canGoBack).toBe(false);
    expect(controls.canGoForward).toBe(false);
    expect(controls.backLabel).toBe("No previous location");
  });

  it("enables back once there is somewhere to return to", () => {
    let history = pushHistory(emptyHistory(), {
      documentId: "doc-1",
      pageNumber: 1,
      kind: "page",
      targetId: null,
    });
    history = pushHistory(history, {
      documentId: "doc-1",
      pageNumber: 4,
      kind: "page",
      targetId: null,
    });

    const controls = historyControls(history);
    expect(controls.canGoBack).toBe(true);
    expect(controls.backLabel).toBe("Go back");
    expect(controls.canGoForward).toBe(false);
  });

  it("describes each jump kind readably", () => {
    expect(describeHistoryEntry({ kind: "bookmark", pageNumber: 3, targetId: "b" })).toBe(
      "Bookmark on page 3",
    );
    expect(describeHistoryEntry({ kind: "comment", pageNumber: 5, targetId: "c" })).toBe(
      "Comment on page 5",
    );
    expect(describeHistoryEntry({ kind: "search", pageNumber: 2, targetId: "s" })).toBe(
      "Search result on page 2",
    );
    expect(describeHistoryEntry({ kind: "page", pageNumber: 9, targetId: null })).toBe("Page 9");
  });

  it("exposes the same bound the domain enforces", () => {
    expect(MAX_HISTORY_ENTRIES).toBe(SPLIT_VIEW_LIMITS.maxHistoryEntries);
  });
});

describe("input validation and errors", () => {
  it("validates a pane id arriving from outside", () => {
    expect(readPaneId("left")).toBe("left");
    expect(readPaneId("middle")).toBeNull();
    expect(readPaneId(null)).toBeNull();
  });

  it("maps failures to actionable messages without leaking internals", () => {
    expect(describeSplitViewError(401)).toContain("Sign in");
    expect(describeSplitViewError(403)).toContain("permission");
    expect(describeSplitViewError(409)).toContain("changed elsewhere");
    expect(describeSplitViewError(500)).toContain("our side");
    expect(describeSplitViewError(500)).not.toMatch(/at .+\(/);
  });
});
