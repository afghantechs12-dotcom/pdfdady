import { describe, expect, it } from "vitest";
import {
  PANE_IDS,
  PRIMARY_PANE,
  SPLIT_VIEW_LIMITS,
  activePaneOf,
  activeTabAfterPaneClose,
  canGoBack,
  canGoForward,
  closePaneAssignments,
  emptyHistory,
  goBack,
  goForward,
  isPaneId,
  isSyncMode,
  layoutOf,
  otherPane,
  paneOfTab,
  pushHistory,
  shouldPropagate,
  syncsPage,
  syncsScroll,
  syncsZoom,
  synchronizedState,
  tabsInPane,
  validatePage,
  type NavigationEntry,
  type NavigationHistory,
} from "./SplitView";

function tab(id: string, paneId?: string) {
  return { id, state: paneId === undefined ? {} : { paneId } };
}

function entry(overrides: Partial<NavigationEntry> = {}): NavigationEntry {
  return {
    documentId: "doc-1",
    pageNumber: 1,
    kind: "page",
    targetId: null,
    ...overrides,
  };
}

describe("pane identity", () => {
  it("accepts only the two stable pane ids", () => {
    expect(PANE_IDS).toEqual(["left", "right"]);
    expect(isPaneId("left")).toBe(true);
    expect(isPaneId("right")).toBe(true);
    expect(isPaneId("middle")).toBe(false);
    expect(isPaneId(null)).toBe(false);
  });

  it("treats an absent or unknown pane as the primary one", () => {
    // A session written before split view, or by a newer build naming a pane
    // this one cannot render, restores as single-pane rather than breaking.
    expect(paneOfTab({})).toBe(PRIMARY_PANE);
    expect(paneOfTab({ paneId: "elsewhere" })).toBe(PRIMARY_PANE);
    expect(paneOfTab({ paneId: "right" })).toBe("right");
  });

  it("pairs each pane with the other", () => {
    expect(otherPane("left")).toBe("right");
    expect(otherPane("right")).toBe("left");
  });
});

describe("layout derivation", () => {
  it("is single until a tab occupies the right pane", () => {
    // Derived rather than stored: a flag saying "split" with nothing on the
    // right would render an empty half nobody asked for.
    expect(layoutOf([tab("a"), tab("b", "left")])).toBe("single");
    expect(layoutOf([tab("a"), tab("b", "right")])).toBe("split");
    expect(layoutOf([])).toBe("single");
  });

  it("groups tabs by pane preserving order", () => {
    const tabs = [tab("a", "left"), tab("b", "right"), tab("c", "left")];
    expect(tabsInPane(tabs, "left").map((t) => t.id)).toEqual(["a", "c"]);
    expect(tabsInPane(tabs, "right").map((t) => t.id)).toEqual(["b"]);
  });
});

describe("active pane", () => {
  it("follows the active tab rather than a stored position", () => {
    const tabs = [tab("a", "left"), tab("b", "right")];
    expect(activePaneOf(tabs, "b")).toBe("right");
    expect(activePaneOf(tabs, "a")).toBe("left");
  });

  it("falls back to the primary pane when nothing is active", () => {
    expect(activePaneOf([tab("a", "right")], null)).toBe(PRIMARY_PANE);
    expect(activePaneOf([tab("a", "right")], "missing")).toBe(PRIMARY_PANE);
  });
});

describe("navigation history", () => {
  it("starts empty with no moves available", () => {
    const history = emptyHistory();
    expect(history.entries).toHaveLength(0);
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it("records each distinct position", () => {
    let history = pushHistory(emptyHistory(), entry({ pageNumber: 1 }));
    history = pushHistory(history, entry({ pageNumber: 5 }));

    expect(history.entries).toHaveLength(2);
    expect(history.cursor).toBe(1);
    expect(canGoBack(history)).toBe(true);
  });

  it("does not record navigating to where you already are", () => {
    // Otherwise back appears to do nothing, stepping between two identical
    // positions.
    let history = pushHistory(emptyHistory(), entry({ pageNumber: 3 }));
    history = pushHistory(history, entry({ pageNumber: 3 }));

    expect(history.entries).toHaveLength(1);
  });

  it("distinguishes the same page in different documents", () => {
    let history = pushHistory(emptyHistory(), entry({ documentId: "doc-1", pageNumber: 2 }));
    history = pushHistory(history, entry({ documentId: "doc-2", pageNumber: 2 }));

    expect(history.entries).toHaveLength(2);
  });

  it("distinguishes different anchors on the same page", () => {
    let history = pushHistory(
      emptyHistory(),
      entry({ pageNumber: 2, kind: "comment", targetId: "th-1" }),
    );
    history = pushHistory(history, entry({ pageNumber: 2, kind: "comment", targetId: "th-2" }));

    expect(history.entries).toHaveLength(2);
  });

  it("steps back and forward through the sequence", () => {
    let history = pushHistory(emptyHistory(), entry({ pageNumber: 1 }));
    history = pushHistory(history, entry({ pageNumber: 2 }));
    history = pushHistory(history, entry({ pageNumber: 3 }));

    const back = goBack(history);
    expect(back.entry?.pageNumber).toBe(2);
    const forward = goForward(back.history);
    expect(forward.entry?.pageNumber).toBe(3);
  });

  it("refuses to step past either end", () => {
    const history = pushHistory(emptyHistory(), entry({ pageNumber: 1 }));
    expect(goBack(history).entry).toBeNull();
    expect(goForward(history).entry).toBeNull();
  });

  it("truncates the forward path when navigating after going back", () => {
    let history = pushHistory(emptyHistory(), entry({ pageNumber: 1 }));
    history = pushHistory(history, entry({ pageNumber: 2 }));
    history = pushHistory(history, entry({ pageNumber: 3 }));
    history = goBack(history).history;

    // Keeping it would offer a "forward" leading somewhere abandoned.
    history = pushHistory(history, entry({ pageNumber: 9 }));
    expect(history.entries.map((e) => e.pageNumber)).toEqual([1, 2, 9]);
    expect(canGoForward(history)).toBe(false);
  });

  it("bounds the history from the front", () => {
    let history: NavigationHistory = emptyHistory();
    for (let page = 1; page <= SPLIT_VIEW_LIMITS.maxHistoryEntries + 10; page += 1) {
      history = pushHistory(history, entry({ pageNumber: page }));
    }

    expect(history.entries).toHaveLength(SPLIT_VIEW_LIMITS.maxHistoryEntries);
    // The oldest entries went, not the newest.
    expect(history.entries.at(-1)?.pageNumber).toBe(SPLIT_VIEW_LIMITS.maxHistoryEntries + 10);
    expect(history.cursor).toBe(SPLIT_VIEW_LIMITS.maxHistoryEntries - 1);
  });

  it("does not mutate the history it was given", () => {
    const original = pushHistory(emptyHistory(), entry({ pageNumber: 1 }));
    const before = original.entries.length;
    pushHistory(original, entry({ pageNumber: 2 }));
    expect(original.entries).toHaveLength(before);
  });
});

describe("page validation", () => {
  it("accepts a real 1-based page", () => {
    expect(validatePage(1)).toBe(1);
    expect(validatePage(500)).toBe(500);
  });

  it("rejects anything unusable", () => {
    expect(validatePage(0)).toBeNull();
    expect(validatePage(-1)).toBeNull();
    expect(validatePage(1.5)).toBeNull();
    expect(validatePage(Number.NaN)).toBeNull();
    expect(validatePage(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validatePage(SPLIT_VIEW_LIMITS.maxPage + 1)).toBeNull();
    expect(validatePage("3")).toBeNull();
  });
});

describe("synchronization", () => {
  it("validates the mode", () => {
    expect(isSyncMode("off")).toBe(true);
    expect(isSyncMode("all")).toBe(true);
    expect(isSyncMode("telepathy")).toBe(false);
  });

  it("maps each mode to what it covers", () => {
    expect(syncsPage("page")).toBe(true);
    expect(syncsPage("scroll")).toBe(false);
    expect(syncsScroll("scroll")).toBe(true);
    expect(syncsZoom("zoom")).toBe(true);
    expect(syncsPage("all") && syncsScroll("all") && syncsZoom("all")).toBe(true);
    expect(syncsPage("off") || syncsScroll("off") || syncsZoom("off")).toBe(false);
  });

  it("propagates only a user's own movement", () => {
    // The feedback-loop guard: a pane that moved because it was synchronized
    // must not answer back, or the two would drive each other indefinitely.
    expect(shouldPropagate("user", "all")).toBe(true);
    expect(shouldPropagate("sync", "all")).toBe(false);
    expect(shouldPropagate("restore", "all")).toBe(false);
    expect(shouldPropagate("history", "all")).toBe(false);
  });

  it("never propagates when synchronization is off", () => {
    expect(shouldPropagate("user", "off")).toBe(false);
  });

  it("mirrors only the fields the mode covers", () => {
    const from = { activePage: 7, viewport: { scale: 2, offsetX: 10, offsetY: 20 } };

    // Page-only must not quietly drag the zoom along with it.
    const pageOnly = synchronizedState("page", from);
    expect(pageOnly.activePage).toBe(7);
    expect(pageOnly.viewport).toBeUndefined();

    const zoomOnly = synchronizedState("zoom", from);
    expect(zoomOnly.activePage).toBeUndefined();
    expect(zoomOnly.viewport).toEqual({ scale: 2 });

    const scrollOnly = synchronizedState("scroll", from);
    expect(scrollOnly.viewport).toEqual({ offsetX: 10, offsetY: 20 });

    const all = synchronizedState("all", from);
    expect(all.activePage).toBe(7);
    expect(all.viewport).toEqual({ scale: 2, offsetX: 10, offsetY: 20 });
  });

  it("mirrors nothing when synchronization is off", () => {
    const result = synchronizedState("off", {
      activePage: 3,
      viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    });
    expect(result).toEqual({});
  });
});

describe("pane closing", () => {
  it("moves the closing pane's tabs to the survivor rather than dropping them", () => {
    // A pane arranges documents; collapsing the arrangement must not discard
    // them, least of all one holding unsaved changes.
    const tabs = [tab("a", "left"), tab("b", "right"), tab("c", "right")];
    const moves = closePaneAssignments(tabs, "right");

    expect(moves).toEqual([
      { tabId: "b", paneId: "left" },
      { tabId: "c", paneId: "left" },
    ]);
  });

  it("moves nothing when the closing pane is empty", () => {
    expect(closePaneAssignments([tab("a", "left")], "right")).toEqual([]);
  });

  it("keeps the active tab active when it survives the close", () => {
    const tabs = [tab("a", "left"), tab("b", "right")];
    expect(activeTabAfterPaneClose(tabs, "right", "a")).toBe("a");
  });

  it("chooses a surviving tab when the active one's pane closes", () => {
    const tabs = [tab("a", "left"), tab("b", "right")];
    expect(activeTabAfterPaneClose(tabs, "right", "b")).toBe("a");
  });

  it("falls back to a moved tab when the survivor pane was empty", () => {
    const tabs = [tab("b", "right")];
    // Everything moved left; something must still be showing.
    expect(activeTabAfterPaneClose(tabs, "right", "b")).toBe("b");
  });

  it("returns null only when no tabs remain", () => {
    expect(activeTabAfterPaneClose([], "right", null)).toBeNull();
  });
});
