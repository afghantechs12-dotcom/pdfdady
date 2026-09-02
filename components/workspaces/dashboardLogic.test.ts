import { describe, expect, it } from "vitest";
import {
  DASHBOARD_LIMITS,
  activeFilterChips,
  availableNewActions,
  boundedForDisplay,
  describeActivity,
  documentAreaPhase,
  formatBytes,
  recentDocuments,
  relativeTime,
  viewCountsFromLoadedPage,
  viewLabel,
  type DashboardActivity,
  type DashboardDocument,
} from "./dashboardLogic";

function doc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: "d1",
    name: "Doc",
    favorite: false,
    lifecycleState: "active",
    updatedAt: "2026-08-01T10:00:00.000Z",
    folderId: null,
    projectId: null,
    ...overrides,
  };
}

describe("boundedForDisplay", () => {
  it("reports what it hid rather than truncating silently", () => {
    const result = boundedForDisplay([1, 2, 3, 4, 5], 3);
    expect(result.visible).toEqual([1, 2, 3]);
    expect(result.hiddenCount).toBe(2);
  });

  it("hides nothing when the list fits", () => {
    expect(boundedForDisplay([1, 2], 5)).toEqual({ visible: [1, 2], hiddenCount: 0 });
  });

  it("treats a zero limit as hiding everything", () => {
    expect(boundedForDisplay([1, 2], 0)).toEqual({ visible: [], hiddenCount: 2 });
  });
});

describe("recentDocuments", () => {
  it("orders by most recently updated", () => {
    const items = [
      doc({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      doc({ id: "new", updatedAt: "2026-08-01T00:00:00.000Z" }),
      doc({ id: "mid", updatedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(recentDocuments(items).map((d) => d.id)).toEqual(["new", "mid", "old"]);
  });

  it("excludes archived and trashed documents from the dashboard", () => {
    const items = [
      doc({ id: "a", lifecycleState: "active" }),
      doc({ id: "b", lifecycleState: "archived" }),
      doc({ id: "c", lifecycleState: "trashed" }),
    ];
    expect(recentDocuments(items).map((d) => d.id)).toEqual(["a"]);
  });

  it("bounds the list", () => {
    const items = Array.from({ length: 20 }, (_, i) => doc({ id: `d${i}` }));
    expect(recentDocuments(items)).toHaveLength(DASHBOARD_LIMITS.recentDocuments);
  });

  it("does not mutate the input array", () => {
    const items = [doc({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" }), doc({ id: "b" })];
    const before = items.map((d) => d.id);
    recentDocuments(items);
    expect(items.map((d) => d.id)).toEqual(before);
  });
});

describe("viewCountsFromLoadedPage", () => {
  it("reports no counts at all when the page is partial", () => {
    const counts = viewCountsFromLoadedPage({
      documents: [doc(), doc({ id: "d2", favorite: true })],
      complete: false,
    });
    // A count of "whatever happens to be loaded" changes as you scroll.
    expect(counts.all).toBeUndefined();
    expect(counts.favorites).toBeUndefined();
  });

  it("counts active documents and favorites when the page is complete", () => {
    const counts = viewCountsFromLoadedPage({
      documents: [doc(), doc({ id: "d2", favorite: true }), doc({ id: "d3", favorite: true })],
      complete: true,
    });
    expect(counts.all).toBe(3);
    expect(counts.favorites).toBe(2);
  });

  it("never claims a count for archived or trashed, which an active listing cannot know", () => {
    const counts = viewCountsFromLoadedPage({ documents: [doc()], complete: true });
    expect(counts.archived).toBeUndefined();
    expect(counts.trashed).toBeUndefined();
  });

  it("reports a genuine zero for an empty complete page", () => {
    const counts = viewCountsFromLoadedPage({ documents: [], complete: true });
    expect(counts.all).toBe(0);
    expect(counts.favorites).toBe(0);
  });
});

describe("documentAreaPhase", () => {
  const base = {
    loading: false,
    error: null as string | null,
    itemCount: 0,
    hasQuery: false,
    hasFilters: false,
    workspaceEmpty: false,
  };

  it("prefers the error state over everything else", () => {
    expect(documentAreaPhase({ ...base, error: "boom", loading: true, itemCount: 5 })).toBe("error");
  });

  it("shows results while refreshing rather than flashing a skeleton", () => {
    expect(documentAreaPhase({ ...base, loading: true, itemCount: 5 })).toBe("ready");
  });

  it("shows the loading state only when there is nothing to show yet", () => {
    expect(documentAreaPhase({ ...base, loading: true, itemCount: 0 })).toBe("loading");
  });

  it("distinguishes an empty search from an empty Workspace", () => {
    expect(documentAreaPhase({ ...base, hasQuery: true, workspaceEmpty: false })).toBe("empty-search");
    expect(documentAreaPhase({ ...base, workspaceEmpty: true })).toBe("empty-workspace");
  });

  it("treats a filtered empty view separately from an empty Workspace", () => {
    expect(documentAreaPhase({ ...base, hasFilters: true, workspaceEmpty: false })).toBe("empty-view");
  });
});

describe("activeFilterChips", () => {
  it("produces no chip for the default view", () => {
    expect(activeFilterChips({ view: "all" })).toEqual([]);
  });

  it("chips a non-default view with its human label", () => {
    expect(activeFilterChips({ view: "trashed" })).toEqual([
      { id: "view", label: "View", value: "Trash" },
    ]);
  });

  it("ignores a blank query", () => {
    expect(activeFilterChips({ query: "   " })).toEqual([]);
  });

  it("chips each active filter once", () => {
    const chips = activeFilterChips({
      query: "invoice",
      view: "favorites",
      folderName: "Contracts",
      tagNames: ["urgent", "legal"],
    });
    expect(chips.map((c) => c.id)).toEqual(["query", "view", "folder", "tag:urgent", "tag:legal"]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");

  it("describes recent times", () => {
    expect(relativeTime("2026-08-04T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-04T11:30:00.000Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-08-04T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-03T12:00:00.000Z", now)).toBe("yesterday");
  });

  it("does not render a future timestamp as a negative duration", () => {
    expect(relativeTime("2026-09-01T00:00:00.000Z", now)).toBe("just now");
  });

  it("renders an unparseable value as a dash rather than 'Invalid Date'", () => {
    expect(relativeTime("not a date", now)).toBe("—");
  });
});

describe("describeActivity", () => {
  it("describes known actions in human terms", () => {
    expect(
      describeActivity({
        id: "1",
        action: "document.create",
        createdAt: "2026-08-01T00:00:00.000Z",
        actorLabel: "Ann",
        resourceLabel: "Report.pdf",
      }),
    ).toBe("created Report.pdf");
  });

  it("falls back to a readable form instead of dropping an unknown action", () => {
    expect(
      describeActivity({
        id: "1",
        action: "widget.frobnicated",
        createdAt: "2026-08-01T00:00:00.000Z",
        actorLabel: null,
        resourceLabel: null,
      }),
    ).toBe("widget frobnicated");
  });
});

/*
 * T15-T17 — what an activity line is allowed to know.
 *
 * The defect these pin: every line read "uploaded an item", because the only name
 * available was `resourceLabel` — the page looking the resource id up in the 50
 * documents it happened to have loaded. Anything older, renamed, archived or
 * deleted had no name at all. The fix records the name WITH the event, so these
 * tests are mostly about which of the two sources wins, and what happens when
 * neither answers.
 */
describe("describeActivity — T15/T16/T17 named events", () => {
  const entry = (over: Partial<DashboardActivity>): DashboardActivity => ({
    id: "1",
    action: "document.upload",
    createdAt: "2026-08-01T00:00:00.000Z",
    actorLabel: "Ann",
    resourceLabel: null,
    ...over,
  });

  it("T15 names the document from the event, not from the page's loaded map", () => {
    expect(
      describeActivity(entry({ metadata: { documentName: "Contract.pdf" } })),
    ).toBe("uploaded Contract.pdf");
    // The event wins where they disagree: the page's map is the CURRENT name, the
    // event's is the name at the time, and an activity feed is a history.
    expect(
      describeActivity(
        entry({ resourceLabel: "Renamed.pdf", metadata: { documentName: "Contract.pdf" } }),
      ),
    ).toBe("uploaded Contract.pdf");
  });

  it("T15 says which tool a saved result came from", () => {
    expect(
      describeActivity(
        entry({ metadata: { documentName: "Deck.pdf", toolSlug: "compress-pdf" } }),
      ),
      // The tool's catalog name, not the slug: the slug is what is stored so a
      // rename does not leave stale copies in the database.
    ).toBe("saved Deck.pdf from Compress PDF to this Workspace");
    expect(
      describeActivity(entry({ metadata: { documentName: "Deck.pdf", toolSlug: "gone-tool" } })),
    ).toBe("saved Deck.pdf from gone-tool to this Workspace");
  });

  it("T16 still describes events recorded before metadata existed", () => {
    // The historical fallback. Every entry already in the audit log has no
    // metadata, and a fix that made those read worse would be a regression.
    expect(describeActivity(entry({ resourceLabel: "Report.pdf" }))).toBe(
      "uploaded Report.pdf",
    );
    expect(describeActivity(entry({}))).toBe("uploaded an item");
    expect(describeActivity(entry({ action: "document.move" }))).toBe("moved a document");
  });

  it("T16 ignores metadata that does not carry a usable name", () => {
    // The values arrive as parsed JSON from the audit log, so the readers are
    // checked ones: a number, a blank string or a null must not become the
    // subject of a sentence.
    for (const metadata of [null, "Contract.pdf", { documentName: 42 }, { documentName: "  " }]) {
      expect(describeActivity(entry({ resourceLabel: "Report.pdf", metadata }))).toBe(
        "uploaded Report.pdf",
      );
    }
  });

  it("T17 names the version number a publish produced", () => {
    expect(
      describeActivity(
        entry({
          action: "document.version.create",
          metadata: { documentName: "Report.pdf", versionNumber: 3 },
        }),
      ),
    ).toBe("published version 3 of Report.pdf");
  });

  it("T17 does not invent a version number it was not given", () => {
    // "published version 0 of" and "published version undefined of" are both
    // worse than a sentence without a number.
    for (const versionNumber of [undefined, 0, -1, 1.5, "3"]) {
      expect(
        describeActivity(
          entry({
            action: "document.version.create",
            resourceLabel: "Report.pdf",
            metadata: { versionNumber },
          }),
        ),
      ).toBe("published a new version of Report.pdf");
    }
  });

  it("T17 describes each lifecycle move in its own words", () => {
    const lifecycle = (action: string) =>
      describeActivity(entry({ action, metadata: { documentName: "Report.pdf" } }));
    // Before this, all three fell through the default humanizer and rendered as
    // "document archived" — the action name, not a sentence.
    expect(lifecycle("document.archived")).toBe("archived Report.pdf");
    expect(lifecycle("document.trashed")).toBe("moved Report.pdf to trash");
    expect(lifecycle("document.active")).toBe("restored Report.pdf");
    expect(lifecycle("document.rename")).toBe("renamed a document to Report.pdf");
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("rejects nonsense", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("availableNewActions", () => {
  it("hides write actions from a role that cannot write", () => {
    const ids = availableNewActions(false).map((a) => a.id);
    expect(ids).toEqual(["editor"]);
  });

  it("offers every action to a writer", () => {
    const ids = availableNewActions(true).map((a) => a.id);
    expect(ids).toEqual(["upload", "folder", "project", "editor"]);
  });
});

describe("viewLabel", () => {
  it("labels every known view", () => {
    expect(viewLabel("all")).toBe("All Documents");
    expect(viewLabel("trashed")).toBe("Trash");
  });

  it("passes an unknown view through rather than rendering 'undefined'", () => {
    expect(viewLabel("mystery")).toBe("mystery");
  });
});
