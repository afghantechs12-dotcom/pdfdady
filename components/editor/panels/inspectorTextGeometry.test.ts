import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Inspector's text and geometry controls (P1 Phase H Stage 2).
 *
 * Two things are pinned here, and the second is the load-bearing one:
 *
 * 1. The controls are wired to the shared primitives and the existing facade —
 *    no new transform infrastructure, `setObjectSize` still called ONCE per
 *    locked edit so it stays a single undo entry.
 * 2. The capabilities that DO NOT EXIST are not rendered. The brief asked for
 *    Underline and Justify; `TextDecoration` has no renderer/export support and
 *    `align` has no "justify" member, so building either would be a control that
 *    lies about what the document will contain. An omission test is the only way
 *    that decision survives a future well-meaning edit.
 *
 * Source-level assertions, for the reason given in `inspectorControls.test.ts`:
 * this project's vitest environment is Node with no DOM, and the panel's JSX
 * depends on live editor state (`useEditorContext`) that cannot be rendered
 * standalone. Behaviour that CAN be tested directly lives in
 * `propertiesPanelLogic.test.ts` (positionDelta / lockedSize / describePageSize),
 * which is where the actual arithmetic is asserted.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const panel = read("components", "editor", "panels", "PropertiesPanel.tsx");

describe("text style controls", () => {
  it("offers Bold and Italic as a segmented group", () => {
    expect(panel).toMatch(/label="Text style"/);
    expect(panel).toMatch(/id: "bold"/);
    expect(panel).toMatch(/id: "italic"/);
  });

  it("drives Bold from fontWeight and Italic from the family", () => {
    // The independence contract. Bold must not touch fontFamily and Italic must
    // not touch fontWeight, or toggling one would clobber the other.
    expect(panel).toMatch(/pressed: obj\.fontWeight >= 600/);
    expect(panel).toMatch(/pressed: familyIsItalic\(resolved\.family\)/);
    expect(panel).toMatch(/fontFamily: withItalic\(/);
  });

  it("disables Italic with a reason for fonts that have no italic variant", () => {
    // H24: no dead-looking button. Symbol/ZapfDingbats genuinely cannot slant.
    expect(panel).toMatch(/disabled: !italicSupport\(resolved\.family\)\.supported/);
    expect(panel).toMatch(/reason: italicSupport\(resolved\.family\)\.reason/);
  });

  it("renders NO underline control", () => {
    // `TextDecoration` serializes but has zero renderer/export references, so a
    // U button would change nothing in the canvas or the PDF.
    expect(panel).not.toMatch(/id: "underline"/);
    expect(panel).not.toMatch(/label: "Underline"/);
    expect(panel).not.toMatch(/textDecoration/);
  });

  it("renders NO justify alignment option", () => {
    // `align` is "left" | "center" | "right" in the domain; nothing distributes
    // inter-word space.
    //
    // Scoped to the alignment group rather than the whole file: `justify-center`
    // is a Tailwind flex utility used all over the panel, and the comment
    // explaining this very omission legitimately contains the word. A file-wide
    // /justify/ match forbade both (an earlier version of this test did exactly
    // that and failed on its own documentation).
    const group = panel.slice(panel.indexOf('label="Text alignment"'));
    const block = group.slice(0, group.indexOf("</ControlRow>"));
    expect(block).not.toMatch(/"justify"/);
    expect(block).not.toMatch(/Justify/);
    // The align property is never assigned a justify value anywhere.
    expect(panel).not.toMatch(/align:\s*"justify"/);
    expect(panel).not.toMatch(/AlignJustify/);
  });

  it("keeps alignment to the three real values", () => {
    const group = panel.slice(panel.indexOf('label="Text alignment"'));
    const block = group.slice(0, group.indexOf("</ControlRow>"));
    expect(block).toMatch(/"left"/);
    expect(block).toMatch(/"center"/);
    expect(block).toMatch(/"right"/);
  });
});

describe("position & size section", () => {
  it("uses the 2-up numeric grid rather than four stacked inputs (H25)", () => {
    expect(panel).toMatch(/<NumberPairRow/);
    expect(panel).toMatch(/name: "X position"/);
    expect(panel).toMatch(/name: "Y position"/);
    expect(panel).toMatch(/name: "Width"/);
    expect(panel).toMatch(/name: "Height"/);
  });

  it("commits X/Y as a delta through the existing move action", () => {
    // No new service method: absolute field → relative primitive.
    expect(panel).toMatch(/positionDelta\(/);
    expect(panel).toMatch(/actions\.moveSelection\(delta\)/);
  });

  it("commits a locked resize as ONE setObjectSize call", () => {
    // The single-undo-entry contract. Two chained calls would produce two undo
    // steps for one visible change.
    expect(panel).toMatch(/lockedSize\(/);
    expect(panel).toMatch(/actions\.setObjectSize\(obj\.id, next\.w, next\.h\)/);
    // Exactly one call site in the geometry section.
    const calls = panel.match(/actions\.setObjectSize\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("exposes the aspect lock as a pressed-state toggle with a label", () => {
    expect(panel).toMatch(/aria-pressed=\{locked\}/);
    expect(panel).toMatch(/aria-label="Lock aspect ratio"/);
  });

  it("defaults the lock ON for images only", () => {
    // A photo is where an accidental stretch is most likely and most visible.
    expect(panel).toMatch(/useState\(isObjectKind\(obj, "image"\)\)/);
  });

  it("does not introduce a second transform path", () => {
    // Everything goes through the facade actions that already existed.
    expect(panel).not.toMatch(/new TransformObjectsCommand/);
    expect(panel).not.toMatch(/resizeObject\(/);
  });
});

describe("the read-only source-text rule is untouched", () => {
  it("still gates geometry on the shared affordance verdict", () => {
    // Adding X/Y must NOT leak geometry onto imported PDF text.
    expect(panel).toMatch(/primaryAffordance\.allowsGeometry/);
    expect(panel).toMatch(/resolveSelectionAffordance/);
  });

  it("keeps PositionSection behind that gate", () => {
    const gate = panel.indexOf("primaryAffordance.allowsGeometry");
    const position = panel.indexOf("<PositionSection");
    expect(gate).toBeGreaterThan(-1);
    expect(position).toBeGreaterThan(gate);
  });
});
