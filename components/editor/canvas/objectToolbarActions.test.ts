import { describe, expect, it } from "vitest";
import {
  OBJECT_TOOLBAR_SIZE,
  placeObjectToolbar,
  resolveObjectToolbar,
  type ObjectToolbarActionId,
} from "@/components/editor/canvas/objectToolbarActions";
import type { EditorObject, TextObject } from "@/src/domain/editor/objects";

/**
 * Object factories. Only the fields the resolver actually reads are set; the
 * cast keeps the fixtures honest about that rather than fabricating a full
 * object graph the assertions never touch.
 */
const obj = (kind: string, extra: Record<string, unknown> = {}): EditorObject =>
  ({ id: `${kind}-1`, kind, name: kind, visible: true, locked: false, ...extra }) as unknown as EditorObject;

/** A read-only imported PDF run: `sourceText.mode` is anything but "replace". */
const sourceText = (mode: "readonly" | "direct" = "readonly"): TextObject =>
  obj("text", { sourceText: { mode, runId: "r1" } }) as unknown as TextObject;

const ids = (actions: ReturnType<typeof resolveObjectToolbar>): ObjectToolbarActionId[] =>
  (actions ?? []).map((a) => a.id);

describe("resolveObjectToolbar", () => {
  it("returns null for an empty selection (no toolbar over nothing)", () => {
    expect(resolveObjectToolbar({ objects: [] })).toBeNull();
  });

  it("offers Edit/Duplicate/Delete/More for editable text", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("text")] }))).toEqual([
      "edit",
      "duplicate",
      "delete",
      "more",
    ]);
  });

  it("offers Replace/Crop/Duplicate/Delete/More for an image", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("image")], cropAvailable: true }))).toEqual([
      "replace",
      "crop",
      "duplicate",
      "delete",
      "more",
    ]);
  });

  it("offers Fill/Stroke/Duplicate/Delete/More for a shape", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("shape")] }))).toEqual([
      "fill",
      "stroke",
      "duplicate",
      "delete",
      "more",
    ]);
  });

  it("offers Color/Width for a drawn path", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("drawing")] }))).toEqual([
      "color",
      "width",
      "duplicate",
      "delete",
      "more",
    ]);
  });

  it("offers Color/Opacity/Delete for a highlight", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("highlight")] }))).toEqual([
      "color",
      "opacity",
      "delete",
      "more",
    ]);
  });

  it("offers Edit/Color/Delete for a note annotation", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("annotation")] }))).toEqual([
      "edit",
      "color",
      "delete",
      "more",
    ]);
  });

  it("falls back to safe operations for a signature (no fake signature editor)", () => {
    const actions = resolveObjectToolbar({ objects: [obj("signature")] });
    expect(ids(actions)).toEqual(["duplicate", "delete", "more"]);
    expect(ids(actions)).not.toContain("edit");
  });

  it("reduces a multi-selection to operations that are unambiguous across kinds", () => {
    expect(ids(resolveObjectToolbar({ objects: [obj("text"), obj("image")] }))).toEqual([
      "duplicate",
      "delete",
      "more",
    ]);
  });

  describe("crop availability comes from the caller's canonical verdict", () => {
    it("disables crop with the supplied reason instead of hiding it", () => {
      const actions = resolveObjectToolbar({
        objects: [obj("image")],
        cropAvailable: false,
        cropReason: "Unlock the image to crop",
      });
      const crop = actions?.find((a) => a.id === "crop");
      expect(crop?.enabled).toBe(false);
      expect(crop?.reason).toBe("Unlock the image to crop");
    });
  });

  describe("locked objects", () => {
    it("disables mutating actions with a reason and keeps the rest usable", () => {
      const actions = resolveObjectToolbar({ objects: [obj("text", { locked: true })] });
      const byId = new Map((actions ?? []).map((a) => [a.id, a]));
      expect(byId.get("edit")?.enabled).toBe(false);
      expect(byId.get("edit")?.reason).toBe("Unlock this object to change it");
      expect(byId.get("delete")?.enabled).toBe(false);
      // `More` opens a menu; it mutates nothing itself and must stay reachable.
      expect(byId.get("more")?.enabled).toBe(true);
    });
  });

  /**
   * THE P0 INVARIANT. Read-only imported PDF text may not be moved, resized,
   * restyled, or duplicated into an "editable copy" — that last one was the
   * shipped defect this model replaced. The toolbar must therefore offer only
   * viewer-legitimate operations over the ORIGINAL content.
   */
  describe("read-only imported PDF text (P0)", () => {
    it("offers Copy/Highlight/Comment/More", () => {
      expect(ids(resolveObjectToolbar({ objects: [sourceText()] }))).toEqual([
        "copyText",
        "highlight",
        "comment",
        "more",
      ]);
    });

    it("never offers to duplicate or edit the run", () => {
      const got = ids(resolveObjectToolbar({ objects: [sourceText()] }));
      expect(got).not.toContain("duplicate");
      expect(got).not.toContain("edit");
      expect(got).not.toContain("delete");
    });

    it("never offers a geometry or transform action", () => {
      const got = ids(resolveObjectToolbar({ objects: [sourceText()] }));
      for (const forbidden of ["crop", "replace", "fill", "stroke", "width", "opacity"] as const) {
        expect(got).not.toContain(forbidden);
      }
    });

    it("applies to every read-only source mode, not just `readonly`", () => {
      // `direct` runs are also not editable-as-objects: the page already shows
      // the edit. Both must take the source-text branch.
      expect(ids(resolveObjectToolbar({ objects: [sourceText("direct")] }))).toEqual([
        "copyText",
        "highlight",
        "comment",
        "more",
      ]);
    });

    it("treats a `replace` run as normal editable text (the copy IS the content)", () => {
      const replaced = obj("text", { sourceText: { mode: "replace", runId: "r1" } });
      expect(ids(resolveObjectToolbar({ objects: [replaced] }))).toContain("edit");
    });
  });

  describe("action metadata", () => {
    it("marks Delete as destructive so it can be styled apart", () => {
      const actions = resolveObjectToolbar({ objects: [obj("shape")] });
      expect(actions?.find((a) => a.id === "delete")?.danger).toBe(true);
    });

    it("gives every action a non-empty label and icon", () => {
      for (const kind of ["text", "image", "shape", "drawing", "highlight", "annotation"]) {
        for (const a of resolveObjectToolbar({ objects: [obj(kind)] }) ?? []) {
          expect(a.label.length).toBeGreaterThan(0);
          expect(a.icon.length).toBeGreaterThan(0);
        }
      }
    });

    it("keeps every toolbar to at most 5 actions (it overlays the document)", () => {
      for (const kind of ["text", "image", "shape", "drawing", "highlight", "annotation", "signature"]) {
        expect((resolveObjectToolbar({ objects: [obj(kind)] }) ?? []).length).toBeLessThanOrEqual(5);
      }
    });
  });
});

describe("placeObjectToolbar", () => {
  const container = { width: 1000, height: 800 };
  const size = { width: 200, height: OBJECT_TOOLBAR_SIZE.height };

  it("places the bar above the object and horizontally centred when there is room", () => {
    const p = placeObjectToolbar({ x: 400, y: 300, width: 200, height: 100 }, container, size);
    expect(p.side).toBe("above");
    expect(p.top).toBe(300 - 10 - size.height);
    // Centre of the object is 500; the bar's left edge is 500 − 100.
    expect(p.left).toBe(400);
  });

  it("flips below when the object is against the top edge", () => {
    const p = placeObjectToolbar({ x: 400, y: 4, width: 200, height: 100 }, container, size);
    expect(p.side).toBe("below");
    expect(p.top).toBe(4 + 100 + 10);
  });

  it("clamps to the left edge instead of overflowing the container", () => {
    const p = placeObjectToolbar({ x: 0, y: 300, width: 40, height: 40 }, container, size);
    expect(p.left).toBe(8);
  });

  it("clamps to the right edge instead of overflowing the container", () => {
    const p = placeObjectToolbar({ x: 980, y: 300, width: 40, height: 40 }, container, size);
    expect(p.left).toBe(container.width - size.width - 8);
  });

  it("keeps the bar inside the container for a selection taller than the view", () => {
    const p = placeObjectToolbar({ x: 100, y: -50, width: 200, height: 2000 }, container, size);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + size.height).toBeLessThanOrEqual(container.height);
  });

  it("never returns a negative coordinate", () => {
    const p = placeObjectToolbar({ x: -500, y: -500, width: 10, height: 10 }, container, size);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});
