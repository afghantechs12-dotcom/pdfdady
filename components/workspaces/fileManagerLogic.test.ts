import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  VIEW_EMPTY_MESSAGE,
  bulkLifecycleActions,
  bulkResultMessage,
  lifecycleActionsFor,
  lifecycleCopy,
  normalizeSelection,
  reduceDocumentClick,
  toggleAll,
  sortDocuments,
  relativeDate,
  type DocumentItem,
} from "./fileManagerLogic";

function doc(id: string, overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id,
    name: id,
    favorite: false,
    lifecycleState: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: null,
    folderId: null,
    projectId: null,
    revision: 1,
    ...overrides,
  };
}

describe("normalizeSelection", () => {
  it("drops ids no longer present", () => {
    const sel = { ids: new Set(["a", "b", "c"]), anchorId: "b" };
    expect(normalizeSelection(sel, ["a", "c"]).ids).toEqual(new Set(["a", "c"]));
  });

  it("resets anchor if removed", () => {
    const sel = { ids: new Set(["a", "b"]), anchorId: "b" };
    expect(normalizeSelection(sel, ["a"]).anchorId).toBeNull();
  });
});

describe("reduceDocumentClick", () => {
  const allIds = ["a", "b", "c", "d"];

  it("plain click selects only the clicked item", () => {
    const sel = reduceDocumentClick(EMPTY_SELECTION, allIds, "b", {});
    expect(sel.ids).toEqual(new Set(["b"]));
    expect(sel.anchorId).toBe("b");
  });

  it("ctrl click toggles an item on", () => {
    const sel = reduceDocumentClick({ ids: new Set(["a"]), anchorId: "a" }, allIds, "c", { ctrl: true });
    expect(sel.ids).toEqual(new Set(["a", "c"]));
    expect(sel.anchorId).toBe("c");
  });

  it("ctrl click toggles an item off and moves anchor", () => {
    const sel = reduceDocumentClick({ ids: new Set(["a", "c"]), anchorId: "c" }, allIds, "c", { ctrl: true });
    expect(sel.ids).toEqual(new Set(["a"]));
    expect(sel.anchorId).toBe("a");
  });

  it("shift click selects a contiguous range from anchor", () => {
    const sel = reduceDocumentClick({ ids: new Set(["b"]), anchorId: "b" }, allIds, "d", { shift: true });
    expect(sel.ids).toEqual(new Set(["b", "c", "d"]));
    expect(sel.anchorId).toBe("b");
  });

  it("shift click without an anchor behaves like plain click", () => {
    const sel = reduceDocumentClick(EMPTY_SELECTION, allIds, "c", { shift: true });
    expect(sel.ids).toEqual(new Set(["c"]));
  });

  it("ignores clicks on unknown ids", () => {
    const sel = reduceDocumentClick({ ids: new Set(["a"]), anchorId: "a" }, allIds, "unknown", {});
    expect(sel.ids).toEqual(new Set(["a"]));
  });
});

describe("toggleAll", () => {
  it("selects all when none selected", () => {
    const sel = toggleAll(EMPTY_SELECTION, ["a", "b"]);
    expect(sel.ids).toEqual(new Set(["a", "b"]));
  });

  it("deselects all when all selected", () => {
    const sel = toggleAll({ ids: new Set(["a", "b"]), anchorId: "a" }, ["a", "b"]);
    expect(sel.ids.size).toBe(0);
  });

  it("selects all when some (not all) are selected", () => {
    const sel = toggleAll({ ids: new Set(["a"]), anchorId: "a" }, ["a", "b"]);
    expect(sel.ids).toEqual(new Set(["a", "b"]));
  });
});

describe("sortDocuments", () => {
  it("sorts by name ascending, case-insensitive", () => {
    const items = [doc("1", { name: "banana" }), doc("2", { name: "Apple" })];
    const sorted = sortDocuments(items, "name", "asc");
    expect(sorted.map((d) => d.name)).toEqual(["Apple", "banana"]);
  });

  it("sorts by name descending", () => {
    const items = [doc("1", { name: "Apple" }), doc("2", { name: "banana" })];
    const sorted = sortDocuments(items, "name", "desc");
    expect(sorted.map((d) => d.name)).toEqual(["banana", "Apple"]);
  });

  it("sorts by date field", () => {
    const items = [
      doc("1", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      doc("2", { updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const sorted = sortDocuments(items, "updatedAt", "asc");
    expect(sorted.map((d) => d.id)).toEqual(["2", "1"]);
  });

  it("breaks ties deterministically by id", () => {
    const items = [doc("b", { name: "same" }), doc("a", { name: "same" })];
    const sorted = sortDocuments(items, "name", "asc");
    expect(sorted.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("treats null dates as epoch (sorted first ascending)", () => {
    const items = [doc("1", { lastAccessedAt: "2026-01-01T00:00:00.000Z" }), doc("2", { lastAccessedAt: null })];
    const sorted = sortDocuments(items, "lastAccessedAt", "asc");
    expect(sorted.map((d) => d.id)).toEqual(["2", "1"]);
  });
});

describe("relativeDate", () => {
  it("returns em-dash placeholder for null", () => {
    expect(relativeDate(null)).toBe("—");
  });

  it("returns em-dash placeholder for invalid date", () => {
    expect(relativeDate("not-a-date")).toBe("—");
  });

  it("returns 'Just now' for very recent timestamps", () => {
    expect(relativeDate(new Date())).toBe("Just now");
  });

  it("returns minutes-ago for timestamps within the hour", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(relativeDate(date)).toBe("5m ago");
  });
});

describe("lifecycleActionsFor", () => {
  it("offers archive and trash for an active document", () => {
    expect(lifecycleActionsFor({ lifecycleState: "active" })).toEqual(["archive", "trash"]);
  });

  it("does not re-offer archive for an already-archived document", () => {
    const actions = lifecycleActionsFor({ lifecycleState: "archived" });
    expect(actions).not.toContain("archive");
    expect(actions).toContain("restore");
  });

  it("offers only restore for a trashed document", () => {
    expect(lifecycleActionsFor({ lifecycleState: "trashed" })).toEqual(["restore"]);
  });
});

describe("bulkLifecycleActions", () => {
  it("is empty for an empty selection", () => {
    expect(bulkLifecycleActions([])).toEqual([]);
  });

  it("offers only actions valid for every selected document", () => {
    // Trash is the only transition both an active and an archived document
    // accept; archive is invalid for the archived one and restore for the
    // active one.
    expect(
      bulkLifecycleActions([{ lifecycleState: "active" }, { lifecycleState: "archived" }]),
    ).toEqual(["trash"]);
  });

  it("offers nothing when the selection has no common transition", () => {
    expect(
      bulkLifecycleActions([{ lifecycleState: "active" }, { lifecycleState: "trashed" }]),
    ).toEqual([]);
  });

  it("offers the full set for a uniform active selection", () => {
    expect(
      bulkLifecycleActions([{ lifecycleState: "active" }, { lifecycleState: "active" }]),
    ).toEqual(["archive", "trash"]);
  });
});

describe("lifecycleCopy", () => {
  it("states the count for a bulk confirmation", () => {
    expect(lifecycleCopy("archive", 3).body).toContain("these 3 documents");
  });

  it("uses the singular for one document", () => {
    const copy = lifecycleCopy("trash", 1);
    expect(copy.body).toContain("this document");
    expect(copy.body).not.toMatch(/\d+ documents/);
  });

  it("marks only trash as destructive", () => {
    expect(lifecycleCopy("trash", 1).destructive).toBe(true);
    expect(lifecycleCopy("archive", 1).destructive).toBe(false);
    expect(lifecycleCopy("restore", 1).destructive).toBe(false);
  });
});

describe("bulkResultMessage", () => {
  it("reports a clean success", () => {
    expect(bulkResultMessage({ action: "archive", succeeded: 2, failed: 0 })).toBe(
      "2 documents archived.",
    );
  });

  it("reports partial failure as partial", () => {
    const message = bulkResultMessage({ action: "trash", succeeded: 2, failed: 1 });
    expect(message).toContain("2 documents");
    expect(message).toContain("1 failed");
  });

  it("does not claim success when nothing succeeded", () => {
    const message = bulkResultMessage({ action: "restore", succeeded: 0, failed: 3 });
    expect(message).toContain("No documents");
    expect(message).toContain("3 failed");
  });
});

describe("VIEW_EMPTY_MESSAGE", () => {
  it("names the specific view rather than saying 'no results'", () => {
    expect(VIEW_EMPTY_MESSAGE.favorites).toContain("favorite");
    expect(VIEW_EMPTY_MESSAGE.trashed).toContain("Trash");
    expect(VIEW_EMPTY_MESSAGE.archived).toContain("archived");
  });
});
