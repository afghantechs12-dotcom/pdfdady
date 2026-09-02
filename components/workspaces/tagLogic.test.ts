import { describe, expect, it } from "vitest";
import {
  buildQuery,
  canAddTag,
  emptyDraftCondition,
  filterTags,
  operatorForField,
  readableTextColor,
  summarizeBulkResult,
  toCondition,
  toggleId,
  validateBulkSelection,
  validateCollectionDraft,
  validateColorDraft,
  validateTagDraft,
  type DraftCondition,
  type TagCatalogItem,
} from "./tagLogic";
import { TAG_LIMITS } from "@/src/domain/entities/Tag";
import { SMART_COLLECTION_LIMITS } from "@/src/domain/entities/SmartCollection";

function catalogItem(overrides: Partial<TagCatalogItem> = {}): TagCatalogItem {
  return {
    id: "tag-1",
    name: "Contract",
    normalizedName: "contract",
    color: "#3366cc",
    revision: 1,
    ...overrides,
  };
}

function draft(overrides: Partial<DraftCondition> = {}): DraftCondition {
  return { ...emptyDraftCondition(), ...overrides };
}

describe("tagLogic — tag validation", () => {
  it("accepts a name within bounds", () => {
    expect(validateTagDraft("Contract", [])).toEqual({ ok: true });
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(validateTagDraft("   ", []).ok).toBe(false);
  });

  it("rejects a name past the domain bound", () => {
    const tooLong = "a".repeat(TAG_LIMITS.maxNameLength + 1);
    expect(validateTagDraft(tooLong, []).ok).toBe(false);
  });

  it("detects a collision on the normalized form, not the literal one", () => {
    const existing = [catalogItem()];
    // The server folds case and whitespace, so the UI must warn on the same rule
    // rather than letting the request fail after the user has typed it.
    const result = validateTagDraft("  CONTRACT ", existing);
    expect(result.ok).toBe(false);
  });

  it("does not treat a tag as colliding with itself while renaming", () => {
    const existing = [catalogItem()];
    expect(validateTagDraft("Contract", existing, "tag-1")).toEqual({ ok: true });
  });

  it("accepts an empty colour and rejects a non-hex one", () => {
    expect(validateColorDraft("")).toEqual({ ok: true });
    expect(validateColorDraft("#3366cc")).toEqual({ ok: true });
    expect(validateColorDraft("red").ok).toBe(false);
    expect(validateColorDraft("url(javascript:0)").ok).toBe(false);
  });
});

describe("tagLogic — query building", () => {
  it("picks the operator each field supports", () => {
    expect(operatorForField("name")).toBe("contains");
    expect(operatorForField("createdAt")).toBe("range");
    expect(operatorForField("tags")).toBe("in");
    expect(operatorForField("favorite")).toBe("eq");
  });

  it("treats an unfilled row as not-ready rather than invalid", () => {
    expect(toCondition(emptyDraftCondition())).toBeNull();
    expect(toCondition(draft({ field: "createdAt" }))).toBeNull();
    expect(toCondition(draft({ field: "tags", tagIds: [] }))).toBeNull();
  });

  it("converts a filled row into the domain condition shape", () => {
    expect(toCondition(draft({ field: "name", value: "  contract " }))).toEqual({
      field: "name",
      operator: "contains",
      value: "contract",
    });
    expect(toCondition(draft({ field: "tags", tagIds: ["tag-1", "tag-2"] }))).toEqual({
      field: "tags",
      operator: "in",
      value: ["tag-1", "tag-2"],
    });
    expect(toCondition(draft({ field: "favorite", value: "true" }))).toEqual({
      field: "favorite",
      operator: "eq",
      value: true,
    });
  });

  it("builds a query the domain grammar accepts", () => {
    const query = buildQuery("all", [draft({ field: "name", value: "contract" })]);
    expect(query).not.toBeNull();
    expect(query!.version).toBe(SMART_COLLECTION_LIMITS.queryVersion);
    expect(query!.root.mode).toBe("all");
    expect(query!.root.conditions).toHaveLength(1);
  });

  it("returns null when no row is complete", () => {
    expect(buildQuery("all", [emptyDraftCondition()])).toBeNull();
    expect(buildQuery("all", [])).toBeNull();
  });

  it("drops incomplete rows while keeping the complete ones", () => {
    const query = buildQuery("any", [
      draft({ field: "name", value: "contract" }),
      emptyDraftCondition(),
    ]);
    expect(query!.root.conditions).toHaveLength(1);
  });

  it("refuses a draft the server's grammar would reject", () => {
    // Past the term bound: validated here by the same parser the API uses, so
    // the builder cannot present it as saveable.
    const tooLong = "a".repeat(SMART_COLLECTION_LIMITS.maxTermLength + 1);
    expect(buildQuery("all", [draft({ field: "name", value: tooLong })])).toBeNull();
  });

  it("carries a sort clause through when one is set", () => {
    const query = buildQuery("all", [draft({ field: "name", value: "x" })], {
      field: "updatedAt",
      order: "desc",
    });
    expect(query!.sort).toEqual({ field: "updatedAt", order: "desc" });
  });
});

describe("tagLogic — collection validation", () => {
  it("requires a name", () => {
    expect(validateCollectionDraft("", "all", [draft({ value: "x" })]).ok).toBe(false);
  });

  it("requires at least one complete condition", () => {
    const result = validateCollectionDraft("Contracts", "all", [emptyDraftCondition()]);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("message");
  });

  it("rejects more conditions than the grammar allows", () => {
    const drafts = Array.from({ length: SMART_COLLECTION_LIMITS.maxConditions + 1 }, (_, index) =>
      draft({ value: `term-${index}` }),
    );
    expect(validateCollectionDraft("Wide", "all", drafts).ok).toBe(false);
  });

  it("accepts a complete draft", () => {
    expect(validateCollectionDraft("Contracts", "all", [draft({ value: "contract" })])).toEqual({
      ok: true,
    });
  });
});

describe("tagLogic — selection and bounds", () => {
  it("reports when a document is at its tag cap", () => {
    expect(canAddTag(0)).toBe(true);
    expect(canAddTag(TAG_LIMITS.maxTagsPerDocument - 1)).toBe(true);
    expect(canAddTag(TAG_LIMITS.maxTagsPerDocument)).toBe(false);
  });

  it("validates a bulk selection against the batch bounds", () => {
    expect(validateBulkSelection(["doc-1"], ["tag-1"])).toEqual({ ok: true });
    expect(validateBulkSelection([], ["tag-1"]).ok).toBe(false);
    expect(validateBulkSelection(["doc-1"], []).ok).toBe(false);

    const manyDocs = Array.from({ length: TAG_LIMITS.maxBulkDocuments + 1 }, (_, i) => `doc-${i}`);
    expect(validateBulkSelection(manyDocs, ["tag-1"]).ok).toBe(false);

    const manyTags = Array.from({ length: TAG_LIMITS.maxBulkTags + 1 }, (_, i) => `tag-${i}`);
    expect(validateBulkSelection(["doc-1"], manyTags).ok).toBe(false);
  });

  it("toggles an id without mutating the input", () => {
    const ids = ["a", "b"];
    expect(toggleId(ids, "c")).toEqual(["a", "b", "c"]);
    expect(toggleId(ids, "a")).toEqual(["b"]);
    expect(ids).toEqual(["a", "b"]);
  });

  it("filters the catalog on the normalized form", () => {
    const tags = [
      catalogItem({ id: "t1", name: "Legal Review", normalizedName: "legal review" }),
      catalogItem({ id: "t2", name: "Invoice", normalizedName: "invoice" }),
    ];
    expect(filterTags(tags, "  LEGAL   review ").map((t) => t.id)).toEqual(["t1"]);
    expect(filterTags(tags, "")).toHaveLength(2);
    expect(filterTags(tags, "nothing")).toHaveLength(0);
  });
});

describe("tagLogic — presentation", () => {
  it("picks readable text for light and dark swatches", () => {
    expect(readableTextColor("#ffffff")).toBe("#0f172a");
    expect(readableTextColor("#000080")).toBe("#ffffff");
  });

  it("falls back to the default text colour for an unset or malformed swatch", () => {
    expect(readableTextColor(null)).toBe("#0f172a");
    expect(readableTextColor("red")).toBe("#0f172a");
  });

  it("summarizes a fully successful batch", () => {
    expect(summarizeBulkResult({ succeeded: ["doc-1", "doc-2"], failed: [] })).toBe(
      "2 documents updated.",
    );
    expect(summarizeBulkResult({ succeeded: ["doc-1"], failed: [] })).toBe("1 document updated.");
  });

  it("names the failures rather than only counting them", () => {
    const summary = summarizeBulkResult({
      succeeded: ["doc-1"],
      failed: [
        { documentId: "doc-2", error: "Cannot tag an archived or trashed document." },
        { documentId: "doc-3", error: "Document not found in this workspace." },
      ],
    });
    expect(summary).toContain("1 document updated");
    expect(summary).toContain("doc-2");
    expect(summary).toContain("doc-3");
  });

  it("truncates a long failure list while saying how many were omitted", () => {
    const failed = Array.from({ length: 6 }, (_, index) => ({
      documentId: `doc-${index}`,
      error: "nope",
    }));
    const summary = summarizeBulkResult({ succeeded: [], failed });
    expect(summary).toContain("and 3 more");
  });
});
