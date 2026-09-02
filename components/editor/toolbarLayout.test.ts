import { describe, expect, it } from "vitest";
import {
  ALL_TOOLBAR_TOOLS,
  TOOLBAR_GROUPS,
  TOOL_LABELS,
  groupPresentation,
  labelledGroups,
  labelledOverflowTools,
  overflowTools,
  resolveActiveTool,
  resolveToolbarMode,
  toolActionLabel,
  toolAvailability,
  toolDefinition,
  toolShortcutKeys,
  visibleGroups,
  type ToolbarMode,
} from "@/components/editor/toolbarLayout";
import {
  ALL_EDITOR_TOOLS,
  SHAPE_TOOL_KINDS,
  isBoxTool,
  isCreationTool,
  isEditorTool,
  shapeKindForTool,
} from "@/components/editor/editorTypes";

describe("toolbarLayout — canonical tool table", () => {
  it("contains every editor tool exactly once", () => {
    const ids = ALL_TOOLBAR_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual([...ALL_EDITOR_TOOLS].sort()); // full coverage
  });

  it("keeps the expected group ordering", () => {
    expect(TOOLBAR_GROUPS.map((g) => g.id)).toEqual([
      "navigate",
      "insert",
      "shapes",
      "markup",
      "draw",
      "modify",
    ]);
  });

  it("gives every tool a non-empty label and accessible name", () => {
    for (const t of ALL_TOOLBAR_TOOLS) {
      expect(t.label.length, t.id).toBeGreaterThan(0);
      expect(t.ariaLabel.length, t.id).toBeGreaterThan(0);
      expect(t.icon.length, t.id).toBeGreaterThan(0);
    }
  });

  it("has no duplicate shortcut letters", () => {
    const keys = ALL_TOOLBAR_TOOLS.filter((t) => t.shortcut).map((t) => t.shortcut!.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("derives the shortcut key table consistently with the displayed text", () => {
    const table = toolShortcutKeys();
    for (const t of ALL_TOOLBAR_TOOLS) {
      if (t.shortcut) expect(table[t.shortcut.toLowerCase()]).toBe(t.id);
    }
    // The M6 remap: H = hand (not highlight); highlight moved to G.
    expect(table["h"]).toBe("hand");
    expect(table["g"]).toBe("highlight");
    expect(table["v"]).toBe("select");
    expect(table["e"]).toBe("eraser");
    expect(table["p"]).toBe("path");
    expect(table["c"]).toBe("crop");
  });

  it("provides a display label for every tool (status bar table)", () => {
    for (const id of ALL_EDITOR_TOOLS) {
      expect(TOOL_LABELS[id]).toBeTruthy();
    }
    expect(TOOL_LABELS.path).toBe("Pen");
    expect(TOOL_LABELS.hand).toBe("Hand");
  });
});

describe("toolbarLayout — responsive modes", () => {
  const flatVisible = (mode: ToolbarMode) => visibleGroups(mode).flatMap((g) => g.tools.map((t) => t.id));

  it("desktop shows every tool with nothing in overflow", () => {
    expect(flatVisible("desktop").length).toBe(ALL_TOOLBAR_TOOLS.length);
    expect(overflowTools("desktop")).toEqual([]);
  });

  it("tablet hides priority-3 tools into overflow", () => {
    const visible = flatVisible("tablet");
    const overflow = overflowTools("tablet").map((t) => t.id);
    expect(visible).not.toContain("star");
    expect(overflow).toContain("star");
    expect(overflow).toContain("speechBubble");
    expect(visible.length + overflow.length).toBe(ALL_TOOLBAR_TOOLS.length);
  });

  it("compact keeps only priority-1 tools; the rest overflow in order", () => {
    const visible = flatVisible("compact");
    expect(visible).toContain("select");
    expect(visible).toContain("hand");
    expect(visible).toContain("eraser");
    expect(visible).not.toContain("crop");
    expect(visible).not.toContain("path");
    const overflow = overflowTools("compact").map((t) => t.id);
    expect(overflow).toContain("crop");
    expect(overflow).toContain("path");
    expect(visible.length + overflow.length).toBe(ALL_TOOLBAR_TOOLS.length);
    // Every visible tool is priority 1.
    for (const g of visibleGroups("compact")) for (const t of g.tools) expect(t.priority).toBe(1);
  });

  it("drops groups that become empty in a mode", () => {
    // "modify" has only the priority-2 crop tool, so compact drops the group.
    expect(visibleGroups("compact").map((g) => g.id)).not.toContain("modify");
  });
});

describe("toolbarLayout — labelled (premium) presentation", () => {
  it("gives creation tools a verb-first action label and leaves modes as nouns", () => {
    // The reference design's readability comes from commands, not nouns.
    expect(toolActionLabel(toolDefinition("text")!)).toBe("Add Text");
    expect(toolActionLabel(toolDefinition("image")!)).toBe("Add Image");
    expect(toolActionLabel(toolDefinition("signature")!)).toBe("Sign");
    expect(toolActionLabel(toolDefinition("annotation")!)).toBe("Comment");
    // No verb form defined → falls back to the noun label, never empty.
    expect(toolActionLabel(toolDefinition("select")!)).toBe("Select");
    expect(toolActionLabel(toolDefinition("crop")!)).toBe("Crop");
    for (const t of ALL_TOOLBAR_TOOLS) expect(toolActionLabel(t).length).toBeGreaterThan(0);
  });

  it("clusters shapes and draw in EVERY mode", () => {
    expect(groupPresentation("desktop", TOOLBAR_GROUPS.find((g) => g.id === "shapes")!)).toBe("cluster");
    expect(groupPresentation("desktop", TOOLBAR_GROUPS.find((g) => g.id === "draw")!)).toBe("cluster");
    expect(groupPresentation("desktop", TOOLBAR_GROUPS.find((g) => g.id === "insert")!)).toBe("flat");
    /*
     * `tablet` used to be asserted FLAT here, on the premise that it "has the
     * width to show its icons inline". Measured in Chrome, it does not: the flat
     * tablet row is 875px of scroller content (15 icon tools at 761px plus
     * Organize Pages and More at 57px each), against a 759.7px scroller at
     * 1045px of container and 814.7px at 1100px. And it did not degrade into the
     * sideways scroll the row's backstop promises — the row shrank below its own
     * content, so Organize Pages was laid out ON TOP of Crop (x 725.7-769.7 over
     * x 729-773) and Crop could not be clicked at all.
     *
     * Clustering brings that row to 647px, which fits with 112px of slack at the
     * tightest width in tablet's range. Eraser and Pen move behind the Draw
     * trigger there — the same place they already are at desktop and compact.
     */
    expect(groupPresentation("tablet", TOOLBAR_GROUPS.find((g) => g.id === "shapes")!)).toBe("cluster");
    expect(groupPresentation("tablet", TOOLBAR_GROUPS.find((g) => g.id === "draw")!)).toBe("cluster");
    expect(groupPresentation("tablet", TOOLBAR_GROUPS.find((g) => g.id === "insert")!)).toBe("flat");
    // `compact` clusters for a third reason: at 390px the flat icon row wanted
    // 407px in a 178px viewport, so Rectangle/Ellipse/Draw/Eraser were scrolled
    // out of sight AND absent from `More` (all priority 1). One trigger per group
    // gives every tool a visible affordance. Keeping this flat is the mobile
    // discoverability bug, not a protection against it.
    expect(groupPresentation("compact", TOOLBAR_GROUPS.find((g) => g.id === "shapes")!)).toBe("cluster");
    expect(groupPresentation("compact", TOOLBAR_GROUPS.find((g) => g.id === "draw")!)).toBe("cluster");
    expect(groupPresentation("compact", TOOLBAR_GROUPS.find((g) => g.id === "insert")!)).toBe("flat");
    // Presentation is now a property of the GROUP, not of the mode: no mode may
    // turn a cluster group flat, which is the rule that keeps the row's width
    // predictable across the responsive range.
    for (const mode of ["desktop", "tablet", "compact"] as const) {
      for (const g of TOOLBAR_GROUPS) expect(groupPresentation(mode, g), `${mode}/${g.id}`).toBe(g.presentation);
    }
  });

  it("keeps every clustered tool reachable at tablet too, not just desktop", () => {
    // The width fix must not cost reachability: a clustered group's menu lists
    // every member regardless of priority, so nothing that was inline at tablet
    // before became unreachable — it became one click away, and still appears in
    // exactly one place.
    for (const mode of ["desktop", "tablet", "compact"] as const) {
      const inline = labelledGroups(mode).flatMap((g) => g.tools.map((t) => t.id));
      const more = labelledOverflowTools(mode).map((t) => t.id);
      const seen = [...inline, ...more];
      expect(new Set(seen).size, mode).toBe(seen.length);
      expect([...seen].sort(), mode).toEqual([...ALL_TOOLBAR_TOOLS.map((t) => t.id)].sort());
    }
    const tabletShapes = labelledGroups("tablet").find((g) => g.id === "shapes")!;
    expect(tabletShapes.tools.length).toBe(11);
    const tabletDraw = labelledGroups("tablet").find((g) => g.id === "draw")!;
    expect(tabletDraw.tools.map((t) => t.id)).toEqual(["draw", "eraser", "path"]);
  });

  it("keeps every clustered tool reachable regardless of priority", () => {
    const shapes = labelledGroups("desktop").find((g) => g.id === "shapes")!;
    // All 11 shapes, including the priority-3 ones a flat row would have cut:
    // menu items cost no horizontal space, so hiding them would be arbitrary.
    expect(shapes.tools.map((t) => t.id)).toContain("star");
    expect(shapes.tools.map((t) => t.id)).toContain("speechBubble");
    expect(shapes.tools.length).toBe(11);
  });

  it("never lists a clustered tool in the labelled More menu", () => {
    const more = labelledOverflowTools("desktop").map((t) => t.id);
    // Otherwise a low-priority shape would appear twice — once under Add Shape
    // and again under More.
    for (const id of ["star", "speechBubble", "polygon", "circle", "path"]) {
      expect(more, id).not.toContain(id);
    }
  });

  it("represents every tool exactly once across the labelled row", () => {
    const inline = labelledGroups("desktop").flatMap((g) => g.tools.map((t) => t.id));
    const more = labelledOverflowTools("desktop").map((t) => t.id);
    const seen = [...inline, ...more];
    expect(new Set(seen).size).toBe(seen.length); // nothing duplicated
    expect([...seen].sort()).toEqual([...ALL_TOOLBAR_TOOLS.map((t) => t.id)].sort()); // nothing lost
  });

  it("puts the labelled row inside a common laptop container width", () => {
    // The regression this redesign fixes: labels only appeared >=1900px, so a
    // 1366/1440 laptop — the reference design's own scale — got a bare icon row.
    expect(resolveToolbarMode(1366)).toBe("desktop");
    expect(resolveToolbarMode(1440)).toBe("desktop");
    /*
     * The upper boundary was 1290, and 1290 was a fiction — derived from the same
     * arithmetic that omitted Organize Pages and More from the scroller's content.
     * Measured in Chrome, the labelled scroller wanted 1162px and got 1023px at
     * 1290 and 1099px at 1366, so "Organize Pages" was clipped 63px mid-word at a
     * flagship width and could only be reached by scrolling the toolbar sideways.
     *
     * Fixed by making that toggle icon-only (139.8px → 38px), which brings the
     * labelled content to 1060.3px, and the boundary is now asserted at the
     * re-measured fit: the scroller is `container − 267.3px`, so 1327 is 0.6px
     * short and 1328 is the first width that fits on float geometry.
     */
    expect(resolveToolbarMode(1328)).toBe("desktop");
    expect(resolveToolbarMode(1327)).toBe("tablet");
    expect(resolveToolbarMode(1290)).toBe("tablet");
    /*
     * The lower boundary is the width the tablet ICON row needs once the pinned
     * action cluster is accounted for. Re-measured in P1 (Phase C3) after the
     * labelled controls grew to a 38px minimum and Export's padding widened:
     * a 1024px viewport made the row scroll (`scrollWidth > clientWidth`) where
     * it previously fitted with ~6px to spare, and 1040px fitted.
     *
     * RE-MEASURED AGAIN in the premium visual pass. Putting undo/redo/Open/Export
     * on the row's shared control box (they were 38px in every mode while the
     * icon-mode tools are 44px) widened the pinned cluster by ~6px, and the
     * tablet row then overflowed at 1040 by 6px and at 1044 by 2px, fitting at
     * 1045 (row 761px, cluster 285px — `scripts/editor-audit.mjs`).
     *
     * The boundary is asserted at the MEASURED fit, not at a round number: the
     * value is downstream of the control metrics, so a change to button height or
     * padding is expected to move it again. What must NOT move is 1024px (iPad
     * landscape, a target viewport) landing in COMPACT, so it drops its
     * lowest-priority tools into `More` rather than presenting a horizontally
     * scrolling toolbar.
     */
    expect(resolveToolbarMode(1045)).toBe("tablet");
    expect(resolveToolbarMode(1044)).toBe("compact");
    expect(resolveToolbarMode(1024)).toBe("compact");
  });
});

describe("toolbarLayout — availability rules", () => {
  it("crop requires exactly one selected image", () => {
    expect(toolAvailability("crop", { selectedKinds: [] }).available).toBe(false);
    expect(toolAvailability("crop", { selectedKinds: ["text"] }).available).toBe(false);
    expect(toolAvailability("crop", { selectedKinds: ["image", "image"] }).available).toBe(false);
    expect(toolAvailability("crop", { selectedKinds: ["image"] })).toEqual({ available: true });
    expect(toolAvailability("crop", { selectedKinds: [] }).reason).toMatch(/image/i);
  });

  it("selection-independent tools are always available", () => {
    for (const id of ["select", "hand", "text", "rect", "eraser", "path"] as const) {
      expect(toolAvailability(id, { selectedKinds: [] }).available).toBe(true);
    }
  });

  it("reports unknown tools as unavailable", () => {
    expect(toolAvailability("laser" as never, { selectedKinds: [] }).available).toBe(false);
  });
});

describe("toolbarLayout — resolution + unknown handling", () => {
  it("resolves valid tools and falls back to select for unknown ids", () => {
    expect(resolveActiveTool("hand")).toBe("hand");
    expect(resolveActiveTool("path")).toBe("path");
    expect(resolveActiveTool("nonsense")).toBe("select");
    expect(resolveActiveTool("")).toBe("select");
  });

  it("toolDefinition returns null for unknown ids", () => {
    expect(toolDefinition("nope")).toBeNull();
    expect(toolDefinition("crop")?.requires).toBe("image-selection");
  });
});

describe("editorTypes — tool predicates", () => {
  it("maps every shape tool to a domain ShapeKind 1:1", () => {
    for (const [toolId, kind] of Object.entries(SHAPE_TOOL_KINDS)) {
      expect(shapeKindForTool(toolId as never)).toBe(kind);
    }
    expect(shapeKindForTool("select")).toBeNull();
    expect(shapeKindForTool("draw")).toBeNull();
    expect(shapeKindForTool("path")).toBeNull(); // path creates via the pen workflow, not box drag
  });

  it("classifies box tools as all shape tools plus highlight", () => {
    expect(isBoxTool("rect")).toBe(true);
    expect(isBoxTool("star")).toBe(true);
    expect(isBoxTool("connector")).toBe(true);
    expect(isBoxTool("highlight")).toBe(true);
    expect(isBoxTool("draw")).toBe(false);
    expect(isBoxTool("hand")).toBe(false);
    expect(isBoxTool("eraser")).toBe(false);
  });

  it("classifies non-creating tools correctly", () => {
    for (const id of ["select", "hand", "eraser", "crop"] as const) expect(isCreationTool(id)).toBe(false);
    for (const id of ["text", "rect", "draw", "path", "highlight"] as const) expect(isCreationTool(id)).toBe(true);
  });

  it("guards untrusted strings", () => {
    expect(isEditorTool("speechBubble")).toBe(true);
    expect(isEditorTool("laser")).toBe(false);
  });
});
