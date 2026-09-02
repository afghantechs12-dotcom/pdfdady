import { describe, expect, it } from "vitest";
import {
  EMBEDDED_WRITE_SUPPORT,
  METADATA_KEYS,
  METADATA_LIMITS,
  asciiFallbackFilename,
  buildOutlineTree,
  canWriteEmbedded,
  flattenOutlineTree,
  isBoundedMetadataId,
  isMetadataKey,
  isMetadataOrigin,
  metadataListLimit,
  normalizeAttachmentName,
  parseMetadataFields,
  safeDownloadType,
  serializeMetadataFields,
  uninspectedCapabilityReport,
  validateAnchor,
  validateAttachmentName,
  validateMetadataFields,
  validateMetadataValue,
  validateMimeType,
  validateNote,
  validateOutlineDepth,
  validatePageNumber,
  validateTitle,
  type OutlineItem,
} from "./DocumentMetadata";

/** Builds an outline item; only the structural fields matter to these tests. */
function item(overrides: Partial<OutlineItem> & { id: string }): OutlineItem {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    parentId: null,
    title: overrides.id,
    pageNumber: 1,
    depth: 0,
    orderKey: overrides.id,
    origin: "workspace",
    createdById: "user-1",
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("DocumentMetadata — origins and keys", () => {
  it("accepts only the two known origins", () => {
    expect(isMetadataOrigin("workspace")).toBe(true);
    expect(isMetadataOrigin("embedded")).toBe(true);
    expect(isMetadataOrigin("native")).toBe(false);
    expect(isMetadataOrigin(undefined)).toBe(false);
  });

  it("accepts only allowlisted metadata keys", () => {
    for (const key of METADATA_KEYS) expect(isMetadataKey(key)).toBe(true);
    expect(isMetadataKey("__proto__")).toBe(false);
    expect(isMetadataKey("arbitrary")).toBe(false);
    expect(isMetadataKey(42)).toBe(false);
  });

  it("bounds identifiers used in predicates", () => {
    expect(isBoundedMetadataId("doc-1")).toBe(true);
    expect(isBoundedMetadataId("")).toBe(false);
    expect(isBoundedMetadataId("   ")).toBe(false);
    expect(isBoundedMetadataId("x".repeat(METADATA_LIMITS.maxIdLength + 1))).toBe(false);
    expect(isBoundedMetadataId(null)).toBe(false);
  });
});

describe("DocumentMetadata — field validation", () => {
  it("normalizes whitespace and compatibility forms in a value", () => {
    expect(validateMetadataValue("  Quarterly   Report \n 2026 ")).toBe("Quarterly Report 2026");
  });

  it("treats null, undefined and blank as clearing the field", () => {
    expect(validateMetadataValue(null)).toBe("");
    expect(validateMetadataValue(undefined)).toBe("");
    expect(validateMetadataValue("   ")).toBe("");
  });

  it("rejects non-string values rather than coercing them", () => {
    expect(validateMetadataValue(2026)).toBeNull();
    expect(validateMetadataValue(true)).toBeNull();
    expect(validateMetadataValue({ toString: () => "x" })).toBeNull();
  });

  it("rejects a value that exceeds the length bound", () => {
    expect(validateMetadataValue("a".repeat(METADATA_LIMITS.maxValueLength))).toHaveLength(
      METADATA_LIMITS.maxValueLength,
    );
    expect(validateMetadataValue("a".repeat(METADATA_LIMITS.maxValueLength + 1))).toBeNull();
  });

  it("rejects control characters and bidi overrides", () => {
    expect(validateMetadataValue(`a${String.fromCharCode(0)}b`)).toBeNull();
    expect(validateMetadataValue(`a${String.fromCharCode(0x202e)}b`)).toBeNull();
    expect(validateMetadataValue(`a${String.fromCharCode(0x2066)}b`)).toBeNull();
  });

  it("reports unknown keys instead of silently dropping them", () => {
    const result = validateMetadataFields({ author: "Ada", nonsense: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ author: "Ada" });
    expect(result.rejected).toEqual(["nonsense"]);
  });

  it("omits cleared fields so 'set to empty' and 'not set' converge", () => {
    const result = validateMetadataFields({ author: "Ada", subject: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ author: "Ada" });
    expect("subject" in result.fields).toBe(false);
  });

  it("rejects a non-object field map", () => {
    expect(validateMetadataFields(null).ok).toBe(false);
    expect(validateMetadataFields([]).ok).toBe(false);
    expect(validateMetadataFields("author=Ada").ok).toBe(false);
  });

  it("rejects more fields than the bound allows", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= METADATA_LIMITS.maxFields; i += 1) many[`key-${i}`] = "x";
    const result = validateMetadataFields(many);
    expect(result.ok).toBe(false);
  });

  it("rejects the whole map when one allowlisted value is unusable", () => {
    const result = validateMetadataFields({
      author: "Ada",
      subject: "x".repeat(METADATA_LIMITS.maxValueLength + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("does not let a prototype-polluting key through", () => {
    const result = validateMetadataFields(JSON.parse('{"__proto__":{"admin":true},"author":"Ada"}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ author: "Ada" });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe("DocumentMetadata — field serialization", () => {
  it("serializes in a stable key order regardless of insertion order", () => {
    const a = serializeMetadataFields({ subject: "S", author: "A", title: "T" });
    const b = serializeMetadataFields({ title: "T", subject: "S", author: "A" });
    expect(a).toBe(b);
  });

  it("round-trips through parse", () => {
    const fields = { title: "Contract", author: "Ada", keywords: "a, b" };
    expect(parseMetadataFields(serializeMetadataFields(fields))).toEqual(fields);
  });

  it("returns an empty map for unusable stored text rather than throwing", () => {
    expect(parseMetadataFields("not json")).toEqual({});
    expect(parseMetadataFields("[1,2]")).toEqual({});
    expect(parseMetadataFields("null")).toEqual({});
    expect(parseMetadataFields("")).toEqual({});
    expect(parseMetadataFields(undefined)).toEqual({});
  });

  it("drops a field a newer build wrote instead of failing the whole read", () => {
    expect(parseMetadataFields('{"author":"Ada","futureKey":"x"}')).toEqual({ author: "Ada" });
  });

  it("drops a stored value that no longer validates", () => {
    const oversize = JSON.stringify({ author: "Ada", subject: "x".repeat(5000) });
    expect(parseMetadataFields(oversize)).toEqual({ author: "Ada" });
  });
});

describe("DocumentMetadata — titles, notes and anchors", () => {
  it("normalizes and bounds a title", () => {
    expect(validateTitle("  Chapter   One  ")).toBe("Chapter One");
    expect(validateTitle("a".repeat(METADATA_LIMITS.maxTitleLength + 1))).toBeNull();
    expect(validateTitle("")).toBeNull();
    expect(validateTitle(7)).toBeNull();
  });

  it("collapses a newline in a title, so it cannot forge a second line", () => {
    expect(validateTitle("Chapter\nOne")).toBe("Chapter One");
  });

  it("distinguishes an absent note from an unusable one", () => {
    expect(validateNote(undefined)).toBeUndefined();
    expect(validateNote(null)).toBeUndefined();
    expect(validateNote("   ")).toBeUndefined();
    expect(validateNote(5)).toBeNull();
    expect(validateNote("x".repeat(METADATA_LIMITS.maxNoteLength + 1))).toBeNull();
  });

  it("preserves paragraphs in a note but collapses padding", () => {
    expect(validateNote("first\n\n\n\nsecond")).toBe("first\n\nsecond");
    expect(validateNote("first\r\nsecond")).toBe("first\nsecond");
  });

  it("rejects a note carrying a control character", () => {
    expect(validateNote(`a${String.fromCharCode(0)}b`)).toBeNull();
  });

  it("bounds a page number to a positive integer within range", () => {
    expect(validatePageNumber(1)).toBe(1);
    expect(validatePageNumber(0)).toBeNull();
    expect(validatePageNumber(-1)).toBeNull();
    expect(validatePageNumber(1.5)).toBeNull();
    expect(validatePageNumber(Number.NaN)).toBeNull();
    expect(validatePageNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validatePageNumber(METADATA_LIMITS.maxPageNumber + 1)).toBeNull();
    expect(validatePageNumber("3")).toBeNull();
  });

  it("accepts a fractional anchor and refuses one outside the page", () => {
    expect(validateAnchor({ x: 0.5, y: 0.25 })).toEqual({ ok: true, anchor: { x: 0.5, y: 0.25 } });
    expect(validateAnchor({ x: 0, y: 1 })).toEqual({ ok: true, anchor: { x: 0, y: 1 } });
    expect(validateAnchor({ x: 1.5, y: 0 })).toEqual({ ok: false });
    expect(validateAnchor({ x: -0.1, y: 0 })).toEqual({ ok: false });
    expect(validateAnchor({ x: 100, y: 200 })).toEqual({ ok: false });
    expect(validateAnchor({ x: "1", y: 0 })).toEqual({ ok: false });
    expect(validateAnchor([0.5, 0.5])).toEqual({ ok: false });
  });

  it("treats an absent anchor as a whole-page bookmark", () => {
    expect(validateAnchor(undefined)).toEqual({ ok: true, anchor: null });
    expect(validateAnchor(null)).toEqual({ ok: true, anchor: null });
  });

  it("bounds an outline depth", () => {
    expect(validateOutlineDepth(0)).toBe(0);
    expect(validateOutlineDepth(METADATA_LIMITS.maxOutlineDepth)).toBe(
      METADATA_LIMITS.maxOutlineDepth,
    );
    expect(validateOutlineDepth(METADATA_LIMITS.maxOutlineDepth + 1)).toBeNull();
    expect(validateOutlineDepth(-1)).toBeNull();
    expect(validateOutlineDepth(1.5)).toBeNull();
  });
});

describe("DocumentMetadata — attachment names and types", () => {
  it("accepts an ordinary filename and derives a matching form", () => {
    expect(validateAttachmentName("Report Q3.pdf")).toEqual({
      name: "Report Q3.pdf",
      normalizedName: "report q3.pdf",
    });
  });

  it("refuses path separators and traversal segments", () => {
    expect(validateAttachmentName("../etc/passwd")).toBeNull();
    expect(validateAttachmentName("a/b.pdf")).toBeNull();
    expect(validateAttachmentName("a\\b.pdf")).toBeNull();
    expect(validateAttachmentName("..")).toBeNull();
    expect(validateAttachmentName(".")).toBeNull();
  });

  it("refuses control characters, which would split a response header", () => {
    // CR and LF are whitespace, so normalization collapses them to a space
    // before the forbidden-code-point check ever sees them — the name is
    // accepted, but as a single line that cannot forge a header.
    expect(validateAttachmentName(`a${String.fromCharCode(13)}${String.fromCharCode(10)}b.pdf`))
      .toEqual({ name: "a b.pdf", normalizedName: "a b.pdf" });
    // A non-whitespace control character has no such collapse and is refused.
    expect(validateAttachmentName(`a${String.fromCharCode(0)}b.pdf`)).toBeNull();
    expect(validateAttachmentName(`a${String.fromCharCode(0x7f)}b.pdf`)).toBeNull();
  });

  it("refuses an embedded content URL as a name", () => {
    expect(validateAttachmentName("data:text/html,<script>")).toBeNull();
    expect(validateAttachmentName("javascript:alert(1)")).toBeNull();
  });

  it("bounds the name length in code points", () => {
    const long = "é".repeat(METADATA_LIMITS.maxAttachmentNameLength + 1);
    expect(validateAttachmentName(long)).toBeNull();
  });

  it("normalizes case locale-independently", () => {
    expect(normalizeAttachmentName("REPORT.PDF")).toBe("report.pdf");
    expect(normalizeAttachmentName("  Report   Final.pdf ")).toBe("report final.pdf");
  });

  it("validates a MIME type into a bounded type/subtype pair", () => {
    expect(validateMimeType("application/pdf")).toBe("application/pdf");
    expect(validateMimeType("APPLICATION/PDF")).toBe("application/pdf");
    expect(validateMimeType("text/html; charset=utf-8")).toBeNull();
    expect(validateMimeType("application/pdf\r\nX-Evil: 1")).toBeNull();
    expect(validateMimeType("notamime")).toBeNull();
    expect(validateMimeType("")).toBeNull();
    expect(validateMimeType(7)).toBeNull();
  });

  it("serves an unlisted type as an opaque download", () => {
    expect(safeDownloadType("application/pdf")).toBe("application/pdf");
    expect(safeDownloadType("image/png")).toBe("image/png");
    expect(safeDownloadType("text/html")).toBe("application/octet-stream");
    expect(safeDownloadType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeDownloadType("application/xhtml+xml")).toBe("application/octet-stream");
  });

  it("produces an ASCII fallback filename that cannot break a header", () => {
    expect(asciiFallbackFilename("Rapport été.pdf")).toBe("Rapport _t_.pdf");
    expect(asciiFallbackFilename('a"b.pdf')).toBe("a_b.pdf");
    expect(asciiFallbackFilename("a\\b.pdf")).toBe("a_b.pdf");
    expect(asciiFallbackFilename(`a${String.fromCharCode(13)}b.pdf`)).toBe("a_b.pdf");
  });

  it("falls back to a generic name when nothing informative survives", () => {
    expect(asciiFallbackFilename("…")).toBe("attachment");
    expect(asciiFallbackFilename("")).toBe("attachment");
    expect(asciiFallbackFilename("..")).toBe("attachment");
    expect(asciiFallbackFilename("日本語")).toBe("attachment");
  });
});

describe("DocumentMetadata — listing limits", () => {
  it("uses the default when no limit is asked for", () => {
    expect(metadataListLimit(undefined)).toBe(METADATA_LIMITS.defaultListLimit);
  });

  it("caps at the domain bound and never widens on a bad value", () => {
    expect(metadataListLimit(Number.POSITIVE_INFINITY)).toBe(METADATA_LIMITS.maxListLimit);
    expect(metadataListLimit(10_000)).toBe(METADATA_LIMITS.maxListLimit);
    expect(metadataListLimit(0)).toBe(1);
    expect(metadataListLimit(-5)).toBe(1);
    expect(metadataListLimit(Number.NaN)).toBe(1);
    expect(metadataListLimit(7.9)).toBe(7);
  });
});

describe("DocumentMetadata — embedded write capability", () => {
  it("reports no embedded write support in this build", () => {
    expect(EMBEDDED_WRITE_SUPPORT).toEqual({
      metadata: false,
      outline: false,
      attachments: false,
    });
    expect(canWriteEmbedded("metadata")).toBe(false);
    expect(canWriteEmbedded("outline")).toBe(false);
    expect(canWriteEmbedded("attachments")).toBe(false);
  });

  it("cannot be granted by mutating the constant", () => {
    const mutable = EMBEDDED_WRITE_SUPPORT as { metadata: boolean };
    expect(() => {
      mutable.metadata = true;
    }).toThrow();
    expect(canWriteEmbedded("metadata")).toBe(false);
  });

  it("describes an uninspected document as uninspected, not as empty", () => {
    const report = uninspectedCapabilityReport();
    expect(report.inspected).toBe(false);
    expect(report.parsed).toBe(false);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("names signature presence rather than validity", () => {
    const report = uninspectedCapabilityReport();
    expect(report).toHaveProperty("signaturePresent");
    expect(Object.keys(report)).not.toContain("signed");
    expect(Object.keys(report)).not.toContain("signatureValid");
  });

  it("hands out a copy of the capability flags, not the frozen constant", () => {
    const report = uninspectedCapabilityReport();
    report.writable.metadata = true;
    expect(canWriteEmbedded("metadata")).toBe(false);
  });
});

describe("DocumentMetadata — outline tree", () => {
  it("nests children under their parents in order-key order", () => {
    const tree = buildOutlineTree([
      item({ id: "b", orderKey: "b" }),
      item({ id: "a", orderKey: "a" }),
      item({ id: "a1", parentId: "a", orderKey: "a1" }),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["a", "b"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["a1"]);
  });

  it("recomputes depth from the parent chain rather than trusting the row", () => {
    const tree = buildOutlineTree([
      item({ id: "a" }),
      item({ id: "a1", parentId: "a", depth: 7 }),
      item({ id: "a1x", parentId: "a1", depth: 0 }),
    ]);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("attaches an orphan at the root rather than hiding it", () => {
    const tree = buildOutlineTree([item({ id: "child", parentId: "missing" })]);
    expect(tree.map((node) => node.id)).toEqual(["child"]);
  });

  it("drops items caught in a cycle instead of looping forever", () => {
    const tree = buildOutlineTree([
      item({ id: "a", parentId: "b" }),
      item({ id: "b", parentId: "a" }),
      item({ id: "c" }),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["c"]);
  });

  it("drops a chain deeper than the depth bound", () => {
    const items: OutlineItem[] = [item({ id: "n0" })];
    for (let i = 1; i <= METADATA_LIMITS.maxOutlineDepth + 2; i += 1) {
      items.push(item({ id: `n${i}`, parentId: `n${i - 1}` }));
    }
    const flat = flattenOutlineTree(buildOutlineTree(items));
    expect(flat).toHaveLength(METADATA_LIMITS.maxOutlineDepth + 1);
    for (const node of flat) {
      expect(node.depth).toBeLessThanOrEqual(METADATA_LIMITS.maxOutlineDepth);
    }
  });

  it("returns an empty tree for no items", () => {
    expect(buildOutlineTree([])).toEqual([]);
    expect(flattenOutlineTree([])).toEqual([]);
  });

  it("flattens back into display order", () => {
    const tree = buildOutlineTree([
      item({ id: "a", orderKey: "a" }),
      item({ id: "a1", parentId: "a", orderKey: "a1" }),
      item({ id: "a2", parentId: "a", orderKey: "a2" }),
      item({ id: "b", orderKey: "b" }),
    ]);
    expect(flattenOutlineTree(tree).map((node) => node.id)).toEqual(["a", "a1", "a2", "b"]);
  });

  it("does not mutate the items it was given", () => {
    const source = item({ id: "a", depth: 9 });
    buildOutlineTree([source, item({ id: "a1", parentId: "a" })]);
    expect(source.depth).toBe(9);
  });

  it("keeps embedded and workspace items distinguishable in the tree", () => {
    const tree = buildOutlineTree([
      item({ id: "w", origin: "workspace", orderKey: "a" }),
      item({ id: "e", origin: "embedded", orderKey: "b" }),
    ]);
    expect(tree.map((node) => node.origin)).toEqual(["workspace", "embedded"]);
  });
});
