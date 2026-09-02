import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectorHeading, pageSizeLabel } from "./propertiesPanelLogic";

/**
 * The Inspector's contextual heading and the no-selection page block
 * (Phase H — H3, H23, H41).
 *
 * The heading is a pure function, so it is tested directly. The page block's
 * wiring is asserted on source text, because the suite runs with
 * `environment: "node"` and no DOM renderer — the point of those assertions is
 * that each control is bound to a REAL facade command, which is a property of the
 * code rather than of the rendered output.
 */

const ROOT = join(__dirname, "..", "..", "..");
const panelSource = readFileSync(
  join(ROOT, "components", "editor", "panels", "PropertiesPanel.tsx"),
  "utf8",
);

describe("inspectorHeading", () => {
  it("names the kind rather than the object's name", () => {
    // The old heading was `Properties · Text 3`: "Properties" duplicated the tab
    // label, and "Text 3" is what the object is CALLED, not what it is.
    expect(inspectorHeading({ count: 1, kind: "text" })).toBe("Text");
    expect(inspectorHeading({ count: 1, kind: "image" })).toBe("Image");
    expect(inspectorHeading({ count: 1, kind: "shape" })).toBe("Shape");
    expect(inspectorHeading({ count: 1, kind: "drawing" })).toBe("Drawing");
    expect(inspectorHeading({ count: 1, kind: "annotation" })).toBe("Annotation");
    expect(inspectorHeading({ count: 1, kind: "signature" })).toBe("Signature");
    expect(inspectorHeading({ count: 1, kind: "highlight" })).toBe("Highlight");
  });

  it("distinguishes imported PDF text from editable text", () => {
    // These support genuinely different actions. One heading for both would make
    // the absent geometry controls read as a bug instead of a fact.
    expect(inspectorHeading({ count: 1, kind: "text", readonlySourceText: true })).toBe(
      "Original PDF text",
    );
    expect(inspectorHeading({ count: 1, kind: "text", readonlySourceText: false })).toBe("Text");
  });

  it("only applies the source-text heading to text", () => {
    // An image is never "Original PDF text", whatever the flag says.
    expect(inspectorHeading({ count: 1, kind: "image", readonlySourceText: true })).toBe("Image");
  });

  it("counts a multi-selection", () => {
    expect(inspectorHeading({ count: 2, kind: "text" })).toBe("2 objects selected");
    expect(inspectorHeading({ count: 17, kind: "shape" })).toBe("17 objects selected");
  });

  it("still reports the count when the primary object cannot be resolved", () => {
    // Handles are on screen; answering "Page" would claim nothing is selected.
    expect(inspectorHeading({ count: 3, kind: null })).toBe("3 objects selected");
  });

  it("reads 'Page' when nothing is selected", () => {
    expect(inspectorHeading({ count: 0, kind: null })).toBe("Page");
    expect(inspectorHeading({ count: -1, kind: null })).toBe("Page");
  });

  it("falls back to 'Object' for a plugin-defined kind, never the raw token", () => {
    // `kind` is an internal token; a heading is UI copy.
    expect(inspectorHeading({ count: 1, kind: "sparkline-widget" })).toBe("Object");
    expect(inspectorHeading({ count: 1, kind: "" })).toBe("Object");
  });

  it("never emits the redundant 'Properties ·' prefix (H41)", () => {
    for (const kind of [null, "text", "image", "shape", "unknown"]) {
      for (const count of [0, 1, 4]) {
        expect(inspectorHeading({ count, kind })).not.toContain("Properties");
        expect(inspectorHeading({ count, kind })).not.toContain("·");
      }
    }
  });
});

describe("the panel renders the contextual heading", () => {
  it("uses the helper instead of an inline template string", () => {
    expect(panelSource).toContain("inspectorHeading(");
    expect(panelSource).not.toContain("`Properties · ");
  });

  it("passes the read-only source-text verdict, not just the kind", () => {
    expect(panelSource).toMatch(/readonlySourceText:[\s\S]{0,120}isReadonlySourceText\(primary\)/);
  });
});

describe("the no-selection page block offers only real actions (H23)", () => {
  /** The no-selection branch, up to the multi-selection branch that follows it. */
  const emptyBranch = panelSource.slice(
    panelSource.indexOf("if (selection.objects.length === 0)"),
    panelSource.indexOf("if (selection.objects.length > 1)"),
  );

  it("shows the page size through the shared label helper", () => {
    expect(emptyBranch).toContain("pageSizeLabel(activePage.width, activePage.height)");
  });

  it("names a standard size and always states the exact dimensions", () => {
    expect(pageSizeLabel(595, 842)).toBe("A4 · 595 × 842 pt");
    // An unrecognized size is unnamed rather than mislabelled as the nearest one.
    expect(pageSizeLabel(500, 700)).toBe("500 × 700 pt");
  });

  it("binds Rotate, Duplicate and Delete to real facade commands", () => {
    expect(emptyBranch).toContain("service.rotatePageBy(activePage.id, 90)");
    expect(emptyBranch).toContain("service.duplicatePage(activePage.id)");
    expect(emptyBranch).toContain("service.deletePage(activePage.id)");
  });

  it("refuses to delete the last page, and says why", () => {
    expect(emptyBranch).toMatch(/disabled=\{pages\.length <= 1\}/);
    expect(emptyBranch).toContain("A document must keep at least one page.");
  });

  it("replaced the two permanently-disabled page size inputs", () => {
    // A field that can never become enabled reads as a broken control, not as a
    // readout. Width/Height are now text, so no disabled NumberField remains.
    expect(emptyBranch).not.toMatch(/NumberField[^>]*disabled/);
  });

  it("reports the page count as a document fact", () => {
    expect(emptyBranch).toContain("Document");
    expect(emptyBranch).toMatch(/Pages/);
    expect(emptyBranch).toContain("pages.length");
  });

  it("still tells the user how to get object properties", () => {
    expect(emptyBranch).toContain("Select an object to edit its properties.");
  });

  it("does not offer a page size picker, which is not implemented", () => {
    // No `setPageSize` exists on the facade; a select here would be fake UI.
    expect(emptyBranch).not.toMatch(/setPageSize|resizePage|SelectField/);
  });
});

describe("secondary actions share one control", () => {
  const controls = readFileSync(
    join(ROOT, "components", "editor", "InspectorControls.tsx"),
    "utf8",
  );

  it("SecondaryButton requires a title so a disabled reason cannot be omitted (H24)", () => {
    const body = controls.slice(controls.indexOf("export function SecondaryButton"));
    const signature = body.slice(0, body.indexOf("}) {"));
    // Required, not `title?:`.
    expect(signature).toMatch(/\btitle: string/);
    expect(signature).not.toMatch(/\btitle\?:/);
  });

  it("the panel no longer carries its own outlined-button class string", () => {
    // One shared control, so disabled styling is defined once.
    expect(panelSource).not.toMatch(/rounded border border-editor-border px-1 py-1 text-xs/);
  });
});
