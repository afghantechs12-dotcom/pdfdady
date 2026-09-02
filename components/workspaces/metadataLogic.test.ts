import { describe, expect, it } from "vitest";
import {
  METADATA_FIELD_LABELS,
  canAddAttachment,
  canDownload,
  canNestUnder,
  downloadTypeLabel,
  draftFromFields,
  emptyBookmarkDraft,
  formatByteSize,
  isActivationKey,
  isConflictMessage,
  isDownloadTypeNarrowed,
  isEditableOrigin,
  isNarrowLayout,
  metadataFieldOrder,
  originLabel,
  outlineIndentRem,
  outlineRows,
  readOnlyExplanation,
  saveStateFromError,
  sectionPhase,
  sortBookmarks,
  unavailableReason,
  validateAttachmentFilename,
  validateBookmarkDraft,
  validateMetadataDraft,
  type AttachmentView,
  type BookmarkView,
} from "./metadataLogic";
import {
  METADATA_KEYS,
  METADATA_LIMITS,
  type OutlineItem,
} from "@/src/domain/entities/DocumentMetadata";

function outlineItem(overrides: Partial<OutlineItem> = {}): OutlineItem {
  return {
    id: "o-1",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    parentId: null,
    title: "Chapter",
    pageNumber: 1,
    depth: 0,
    orderKey: "m",
    origin: "workspace",
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentView> = {}): AttachmentView {
  return {
    id: "a-1",
    origin: "workspace",
    name: "Budget.xlsx",
    description: null,
    mimeType: "application/vnd.ms-excel",
    byteSize: 2048,
    downloadable: true,
    revision: 1,
    ...overrides,
  };
}

describe("metadataLogic — metadata field validation", () => {
  it("labels every allowlisted key", () => {
    for (const key of METADATA_KEYS) {
      expect(METADATA_FIELD_LABELS[key]).toBeTruthy();
    }
  });

  it("orders fields by the domain allowlist", () => {
    expect(metadataFieldOrder()).toEqual(METADATA_KEYS);
  });

  it("seeds a draft with every key, absent ones empty", () => {
    const draft = draftFromFields({ title: "Report" });

    expect(draft.title).toBe("Report");
    expect(draft.author).toBe("");
    expect(Object.keys(draft)).toHaveLength(METADATA_KEYS.length);
  });

  it("seeds an empty draft from no metadata", () => {
    const draft = draftFromFields(null);

    expect(Object.values(draft).every((value) => value === "")).toBe(true);
  });

  it("accepts a valid draft and normalizes its values", () => {
    const result = validateMetadataDraft({ title: "  Quarterly   report  " });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fields.title).toBe("Quarterly report");
  });

  it("omits cleared fields from the payload", () => {
    const result = validateMetadataDraft({ title: "Kept", author: "" });

    expect(result.ok).toBe(true);
    // "Set to empty" and "not set" converge, matching the domain — otherwise a
    // cleared field would be stored as an empty string and read back as set.
    if (result.ok) expect(result.fields).toEqual({ title: "Kept" });
  });

  it("rejects an unknown field rather than dropping it", () => {
    const result = validateMetadataDraft({ title: "Fine", injected: "value" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.key)).toEqual(["injected"]);
  });

  it("rejects a value beyond the length bound", () => {
    const result = validateMetadataDraft({
      title: "x".repeat(METADATA_LIMITS.maxValueLength + 1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].key).toBe("title");
  });

  it("rejects a value at the length bound only when it exceeds it", () => {
    const result = validateMetadataDraft({
      title: "x".repeat(METADATA_LIMITS.maxValueLength),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a value containing a control character", () => {
    const result = validateMetadataDraft({ title: `Report${String.fromCodePoint(0x202e)}` });

    expect(result.ok).toBe(false);
  });

  it("rejects a draft with more fields than the domain allows", () => {
    const draft: Record<string, string> = {};
    for (let i = 0; i < METADATA_LIMITS.maxFields + 1; i += 1) draft[`field${i}`] = "v";
    const result = validateMetadataDraft(draft);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].key).toBe("*");
  });
});

describe("metadataLogic — origin and editability", () => {
  it("treats workspace metadata as editable", () => {
    expect(isEditableOrigin("workspace", "metadata")).toBe(true);
  });

  it("treats embedded metadata as read-only in this build", () => {
    expect(isEditableOrigin("embedded", "metadata")).toBe(false);
  });

  it("treats an embedded outline node as read-only", () => {
    expect(isEditableOrigin("embedded", "outline")).toBe(false);
  });

  it("treats an embedded attachment as read-only", () => {
    expect(isEditableOrigin("embedded", "attachments")).toBe(false);
  });

  it("labels each origin distinctly", () => {
    expect(originLabel("workspace")).not.toBe(originLabel("embedded"));
    expect(originLabel("embedded")).toContain("PDF");
  });

  it("explains why an embedded record cannot be edited", () => {
    // "Read-only" alone reads as a permission problem the user might try to solve
    // by asking an administrator.
    expect(readOnlyExplanation("outline")).toMatch(/rewriting the document/iu);
    expect(readOnlyExplanation("metadata")).toMatch(/part of the PDF file itself/iu);
  });
});

describe("metadataLogic — bookmark validation", () => {
  it("starts from an empty draft", () => {
    expect(emptyBookmarkDraft()).toEqual({ pageNumber: "", title: "", note: "" });
  });

  it("accepts a valid bookmark", () => {
    const result = validateBookmarkDraft({ pageNumber: "5", title: "Clause 4", note: "" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.pageNumber).toBe(5);
      expect(result.draft.title).toBe("Clause 4");
      expect(result.draft.note).toBeNull();
    }
  });

  it("rejects an empty page rather than coercing it to zero", () => {
    const result = validateBookmarkDraft({ pageNumber: "", title: "T", note: "" });

    // Number("") is 0, which would silently become a page no document has.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("pageNumber");
  });

  it("rejects a non-numeric page", () => {
    const result = validateBookmarkDraft({ pageNumber: "12abc", title: "T", note: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("pageNumber");
  });

  it("rejects page zero", () => {
    const result = validateBookmarkDraft({ pageNumber: "0", title: "T", note: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("pageNumber");
  });

  it("rejects a page beyond the domain maximum", () => {
    const result = validateBookmarkDraft({
      pageNumber: String(METADATA_LIMITS.maxPageNumber + 1),
      title: "T",
      note: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("pageNumber");
  });

  it("requires a title", () => {
    const result = validateBookmarkDraft({ pageNumber: "1", title: "   ", note: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("title");
  });

  it("rejects an oversized note", () => {
    const result = validateBookmarkDraft({
      pageNumber: "1",
      title: "T",
      note: "n".repeat(METADATA_LIMITS.maxNoteLength + 1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("note");
  });

  it("keeps a supplied note", () => {
    const result = validateBookmarkDraft({ pageNumber: "1", title: "T", note: "Check this" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.note).toBe("Check this");
  });

  it("orders bookmarks by order key then id", () => {
    const bookmarks: BookmarkView[] = [
      { id: "b-z", pageNumber: 1, title: "Z", note: null, orderKey: "z", revision: 1 },
      { id: "b-m2", pageNumber: 1, title: "M2", note: null, orderKey: "m", revision: 1 },
      { id: "b-m1", pageNumber: 1, title: "M1", note: null, orderKey: "m", revision: 1 },
    ];

    expect(sortBookmarks(bookmarks).map((b) => b.id)).toEqual(["b-m1", "b-m2", "b-z"]);
  });

  it("does not mutate the input list when sorting", () => {
    const bookmarks: BookmarkView[] = [
      { id: "b-z", pageNumber: 1, title: "Z", note: null, orderKey: "z", revision: 1 },
      { id: "b-a", pageNumber: 1, title: "A", note: null, orderKey: "a", revision: 1 },
    ];
    sortBookmarks(bookmarks);

    expect(bookmarks.map((b) => b.id)).toEqual(["b-z", "b-a"]);
  });
});

describe("metadataLogic — outline tree assembly", () => {
  it("assembles rows in tree order with computed depth", () => {
    const rows = outlineRows([
      outlineItem({ id: "root", orderKey: "a" }),
      outlineItem({ id: "child", parentId: "root", orderKey: "b" }),
      outlineItem({ id: "grandchild", parentId: "child", orderKey: "c" }),
    ]);

    expect(rows.map((r) => r.item.id)).toEqual(["root", "child", "grandchild"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("recomputes depth from the parent chain rather than the stored column", () => {
    // A stored depth can disagree with the links after a move, and the links are
    // the structure — rendering the stored value would indent a node wrongly.
    const rows = outlineRows([
      outlineItem({ id: "root", orderKey: "a", depth: 7 }),
      outlineItem({ id: "child", parentId: "root", orderKey: "b", depth: 0 }),
    ]);

    expect(rows.map((r) => r.depth)).toEqual([0, 1]);
  });

  it("marks a node that has children", () => {
    const rows = outlineRows([
      outlineItem({ id: "root", orderKey: "a" }),
      outlineItem({ id: "child", parentId: "root", orderKey: "b" }),
    ]);

    expect(rows[0].hasChildren).toBe(true);
    expect(rows[1].hasChildren).toBe(false);
  });

  it("keeps sibling order deterministic", () => {
    const rows = outlineRows([
      outlineItem({ id: "b", orderKey: "z" }),
      outlineItem({ id: "a", orderKey: "a" }),
    ]);

    expect(rows.map((r) => r.item.id)).toEqual(["a", "b"]);
  });

  it("allows nesting under a workspace node below the depth cap", () => {
    const rows = outlineRows([outlineItem({ id: "root", origin: "workspace" })]);

    expect(canNestUnder(rows[0])).toBe(true);
  });

  it("refuses nesting under an embedded node", () => {
    const rows = outlineRows([outlineItem({ id: "root", origin: "embedded" })]);

    expect(canNestUnder(rows[0])).toBe(false);
  });

  it("refuses nesting at the maximum depth", () => {
    const items: OutlineItem[] = [];
    let parentId: string | null = null;
    for (let depth = 0; depth <= METADATA_LIMITS.maxOutlineDepth; depth += 1) {
      const id = `n-${depth}`;
      items.push(outlineItem({ id, parentId, orderKey: `k${depth}` }));
      parentId = id;
    }
    const rows = outlineRows(items);
    const deepest = rows[rows.length - 1];

    expect(deepest.depth).toBe(METADATA_LIMITS.maxOutlineDepth);
    expect(canNestUnder(deepest)).toBe(false);
  });

  it("bounds the indentation it will produce", () => {
    expect(outlineIndentRem(0)).toBe(0);
    expect(outlineIndentRem(-5)).toBe(0);
    expect(outlineIndentRem(999)).toBe(outlineIndentRem(METADATA_LIMITS.maxOutlineDepth));
  });

  it("attaches an orphan at the root rather than hiding it", () => {
    const rows = outlineRows([outlineItem({ id: "orphan", parentId: "missing" })]);

    expect(rows.map((r) => r.item.id)).toEqual(["orphan"]);
  });
});

describe("metadataLogic — attachment presentation", () => {
  it("formats byte sizes in binary units", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats a large size without a misleading decimal", () => {
    expect(formatByteSize(200 * 1024 * 1024)).toBe("200 MB");
  });

  it("shows a dash for an unusable size", () => {
    expect(formatByteSize(-1)).toBe("—");
    expect(formatByteSize(Number.NaN)).toBe("—");
  });

  it("accepts a valid filename", () => {
    const result = validateAttachmentFilename("Quarterly Report.pdf");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("Quarterly Report.pdf");
  });

  it("rejects a forward-slash path separator", () => {
    expect(validateAttachmentFilename("folder/file.pdf").ok).toBe(false);
  });

  it("rejects a backslash path separator", () => {
    expect(validateAttachmentFilename("folder\\file.pdf").ok).toBe(false);
  });

  it("rejects a traversal name", () => {
    expect(validateAttachmentFilename("../etc/passwd").ok).toBe(false);
  });

  it("rejects an oversized filename", () => {
    const name = `${"n".repeat(METADATA_LIMITS.maxAttachmentNameLength + 1)}.txt`;

    expect(validateAttachmentFilename(name).ok).toBe(false);
  });

  it("rejects an empty filename", () => {
    expect(validateAttachmentFilename("   ").ok).toBe(false);
  });

  it("offers a download for an attachment with bytes", () => {
    expect(canDownload(attachment({ downloadable: true }))).toBe(true);
  });

  it("does not offer a download for an unextracted embedded attachment", () => {
    const embedded = attachment({ origin: "embedded", downloadable: false });

    expect(canDownload(embedded)).toBe(false);
    expect(unavailableReason(embedded)).toMatch(/has not been extracted/iu);
  });

  it("gives no unavailable reason for a downloadable attachment", () => {
    expect(unavailableReason(attachment({ downloadable: true }))).toBeNull();
  });

  it("flags a type that will be narrowed on download", () => {
    // A stored text/html served under its own type would be stored XSS on our
    // origin, so it is narrowed — and saying so beats looking broken.
    expect(isDownloadTypeNarrowed("text/html")).toBe(true);
    expect(downloadTypeLabel("text/html")).toBe("application/octet-stream");
  });

  it("does not flag a type served as itself", () => {
    expect(isDownloadTypeNarrowed("application/pdf")).toBe(false);
    expect(downloadTypeLabel("application/pdf")).toBe("application/pdf");
  });

  it("allows another attachment within both limits", () => {
    expect(canAddAttachment(2, 1024, METADATA_LIMITS.maxAttachmentTotalBytes)).toBe(true);
  });

  it("refuses another attachment at the count limit", () => {
    expect(
      canAddAttachment(
        METADATA_LIMITS.maxAttachmentsPerDocument,
        0,
        METADATA_LIMITS.maxAttachmentTotalBytes,
      ),
    ).toBe(false);
  });

  it("refuses another attachment at the byte quota", () => {
    const limit = METADATA_LIMITS.maxAttachmentTotalBytes;

    expect(canAddAttachment(1, limit, limit)).toBe(false);
  });
});

describe("metadataLogic — section and save state", () => {
  it("shows loading while a request is in flight", () => {
    expect(sectionPhase({ loading: true, error: null, count: 0, loaded: false })).toBe("loading");
  });

  it("shows an error state distinctly from an empty one", () => {
    expect(sectionPhase({ loading: false, error: "boom", count: 0, loaded: true })).toBe("error");
    expect(sectionPhase({ loading: false, error: null, count: 0, loaded: true })).toBe("empty");
  });

  it("shows idle before anything has loaded", () => {
    expect(sectionPhase({ loading: false, error: null, count: 0, loaded: false })).toBe("idle");
  });

  it("shows ready when rows exist", () => {
    expect(sectionPhase({ loading: false, error: null, count: 3, loaded: true })).toBe("ready");
  });

  it("prefers the error state over a stale row count", () => {
    // A failed refresh must not read as success just because old rows are still
    // on screen.
    expect(sectionPhase({ loading: false, error: "boom", count: 5, loaded: true })).toBe("error");
  });

  it("recognizes a stale-revision conflict", () => {
    expect(isConflictMessage("These properties changed since they were loaded.")).toBe(true);
    expect(isConflictMessage("This bookmark changed since it was loaded.")).toBe(true);
  });

  it("does not treat an ordinary rejection as a conflict", () => {
    expect(isConflictMessage("A bookmark title is required.")).toBe(false);
  });

  it("maps a conflict onto its own save state", () => {
    expect(saveStateFromError("These properties changed since they were loaded.")).toEqual({
      kind: "conflict",
    });
  });

  it("maps any other error onto a failed state that keeps the message", () => {
    expect(saveStateFromError("The value supplied is not acceptable.")).toEqual({
      kind: "failed",
      message: "The value supplied is not acceptable.",
    });
  });
});

describe("metadataLogic — interaction affordances", () => {
  it("activates a row on Enter and Space", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("Spacebar")).toBe(true);
  });

  it("does not activate on an unrelated key", () => {
    expect(isActivationKey("Tab")).toBe(false);
    expect(isActivationKey("a")).toBe(false);
  });

  it("stacks sections on a narrow viewport", () => {
    expect(isNarrowLayout(420)).toBe(true);
    expect(isNarrowLayout(1280)).toBe(false);
  });

  it("treats an unusable width as wide rather than collapsing the layout", () => {
    expect(isNarrowLayout(Number.NaN)).toBe(false);
  });
});
