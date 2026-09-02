import { describe, expect, it } from "vitest";
import {
  activePaneOf,
  activeTabAfterClose,
  droppedTabIds,
  droppedTabsMessage,
  findTabForDocument,
  isSplit,
  openIntent,
  panesFromSession,
  reconcileSession,
  type WorkbenchSession,
  type WorkbenchTab,
} from "./workbenchLogic";

function tab(id: string, overrides: Partial<WorkbenchTab> = {}): WorkbenchTab {
  return {
    id,
    documentId: `doc_${id}`,
    versionId: `ver_${id}`,
    title: `${id}.pdf`,
    dirty: false,
    conflict: false,
    paneId: "left",
    ...overrides,
  };
}

function session(tabs: WorkbenchTab[], activeTabId: string | null = null): WorkbenchSession {
  return { id: "sess_1", activeTabId, tabs, version: 1 };
}

describe("panesFromSession", () => {
  it("puts unassigned tabs in the left pane", () => {
    const panes = panesFromSession(session([tab("a"), tab("b")]));
    expect(panes[0].tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(panes[1].tabs).toEqual([]);
  });

  it("separates tabs by pane", () => {
    const panes = panesFromSession(session([tab("a"), tab("b", { paneId: "right" })]));
    expect(panes[0].tabs.map((t) => t.id)).toEqual(["a"]);
    expect(panes[1].tabs.map((t) => t.id)).toEqual(["b"]);
  });

  it("gives each pane its own active tab when the session's is elsewhere", () => {
    const panes = panesFromSession(
      session([tab("a"), tab("b", { paneId: "right" }), tab("c", { paneId: "right" })], "a"),
    );
    expect(panes[0].activeTabId).toBe("a");
    // The right pane falls back to its first tab rather than showing nothing.
    expect(panes[1].activeTabId).toBe("b");
  });

  it("reports a null active tab for an empty pane", () => {
    expect(panesFromSession(session([tab("a")])).at(1)?.activeTabId).toBeNull();
  });
});

describe("isSplit", () => {
  it("is false when every tab is in one pane", () => {
    expect(isSplit(session([tab("a"), tab("b")]))).toBe(false);
  });

  it("is false for an empty session", () => {
    expect(isSplit(session([]))).toBe(false);
  });

  it("is true when both panes hold a tab", () => {
    expect(isSplit(session([tab("a"), tab("b", { paneId: "right" })]))).toBe(true);
  });
});

describe("activePaneOf", () => {
  it("derives the pane from the active tab", () => {
    expect(activePaneOf(session([tab("a"), tab("b", { paneId: "right" })], "b"))).toBe("right");
  });

  it("defaults to the left pane when nothing is active", () => {
    expect(activePaneOf(session([tab("a")], null))).toBe("left");
  });
});

describe("findTabForDocument", () => {
  it("finds an already-open document", () => {
    expect(findTabForDocument(session([tab("a")]), "doc_a")?.id).toBe("a");
  });

  it("returns null when the document is not open", () => {
    expect(findTabForDocument(session([tab("a")]), "doc_z")).toBeNull();
  });
});

describe("openIntent", () => {
  it("focuses an existing tab rather than opening a second one", () => {
    expect(openIntent(session([tab("a")]), "doc_a", 20)).toEqual({ action: "focus", tabId: "a" });
  });

  it("creates a tab for a document that is not open", () => {
    expect(openIntent(session([tab("a")]), "doc_z", 20)).toEqual({ action: "create" });
  });

  it("refuses past the tab cap with a message naming the limit", () => {
    const tabs = Array.from({ length: 3 }, (_, i) => tab(String(i)));
    const intent = openIntent(session(tabs), "doc_z", 3);
    expect(intent.action).toBe("refuse");
    if (intent.action !== "refuse") return;
    expect(intent.reason).toContain("3");
  });

  it("still focuses an open document when at the cap", () => {
    const tabs = Array.from({ length: 3 }, (_, i) => tab(String(i)));
    expect(openIntent(session(tabs), "doc_1", 3)).toEqual({ action: "focus", tabId: "1" });
  });
});

describe("activeTabAfterClose", () => {
  it("leaves the active tab alone when a different tab closes", () => {
    expect(activeTabAfterClose(session([tab("a"), tab("b")], "a"), "b")).toBe("a");
  });

  it("prefers the left neighbour in the same pane", () => {
    expect(activeTabAfterClose(session([tab("a"), tab("b"), tab("c")], "b"), "b")).toBe("a");
  });

  it("falls back to the right neighbour when closing the first tab", () => {
    expect(activeTabAfterClose(session([tab("a"), tab("b")], "a"), "a")).toBe("b");
  });

  it("does not jump to the other pane while the same pane has tabs", () => {
    const state = session([tab("a"), tab("b"), tab("c", { paneId: "right" })], "a");
    expect(activeTabAfterClose(state, "a")).toBe("b");
  });

  it("falls back across panes when the pane empties", () => {
    const state = session([tab("a"), tab("b", { paneId: "right" })], "a");
    expect(activeTabAfterClose(state, "a")).toBe("b");
  });

  it("returns null when the last tab closes", () => {
    expect(activeTabAfterClose(session([tab("a")], "a"), "a")).toBeNull();
  });
});

describe("reconcileSession", () => {
  it("returns the incoming session on first load", () => {
    const incoming = session([tab("a")]);
    expect(reconcileSession(null, incoming)).toBe(incoming);
  });

  it("drops tabs the server no longer knows about", () => {
    const previous = session([tab("a"), tab("b")]);
    const incoming = session([tab("a")]);
    expect(reconcileSession(previous, incoming).tabs.map((t) => t.id)).toEqual(["a"]);
  });

  it("carries a local dirty flag forward for a surviving tab", () => {
    const previous = session([tab("a", { dirty: true })]);
    const incoming = session([tab("a", { dirty: false })]);
    expect(reconcileSession(previous, incoming).tabs[0].dirty).toBe(true);
  });

  it("does not resurrect the dirty flag of a dropped tab", () => {
    const previous = session([tab("a", { dirty: true }), tab("b", { dirty: true })]);
    const incoming = session([tab("b", { dirty: false })]);
    const result = reconcileSession(previous, incoming);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].id).toBe("b");
  });

  it("takes the server's version counter", () => {
    const previous = { ...session([tab("a")]), version: 2 };
    const incoming = { ...session([tab("a")]), version: 9 };
    expect(reconcileSession(previous, incoming).version).toBe(9);
  });

  it("takes the server's conflict flag rather than the client's", () => {
    const previous = session([tab("a", { conflict: false })]);
    const incoming = session([tab("a", { conflict: true })]);
    expect(reconcileSession(previous, incoming).tabs[0].conflict).toBe(true);
  });
});

describe("droppedTabIds", () => {
  it("is empty on first load", () => {
    expect(droppedTabIds(null, session([tab("a")]))).toEqual([]);
  });

  it("names the tabs the server dropped", () => {
    expect(droppedTabIds(session([tab("a"), tab("b")]), session([tab("a")]))).toEqual(["b"]);
  });

  it("is empty when nothing was dropped", () => {
    expect(droppedTabIds(session([tab("a")]), session([tab("a"), tab("b")]))).toEqual([]);
  });
});

describe("droppedTabsMessage", () => {
  it("says nothing when nothing was dropped", () => {
    expect(droppedTabsMessage(0)).toBeNull();
  });

  it("uses the singular for one tab", () => {
    expect(droppedTabsMessage(1)).toContain("1 tab was closed");
  });

  it("reports the count for several", () => {
    expect(droppedTabsMessage(3)).toContain("3 tabs were closed");
  });
});
