import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import {
  ColorField,
  FieldGroup,
  InspectorSection,
  NumberField,
  NumberPairRow,
  SegmentedControl,
  SelectField,
  Slider,
} from "@/components/editor/InspectorControls";

/**
 * The Inspector control system (P1 Phase H Stage 1).
 *
 * WHY SERVER RENDERING RATHER THAN A DOM LIBRARY: this repo's vitest config is
 * `environment: "node"` with `include: ["**\/*.test.ts"]` — there is no jsdom,
 * no happy-dom and no @testing-library, and a `.test.tsx` file is not even
 * collected. Rather than add a DOM stack (a dependency + config change well
 * outside this stage's scope), these tests render the real components with
 * `react-dom/server` and assert on the emitted markup. That covers exactly what
 * this stage changed: the shared control shell, the ARIA contracts, and the
 * static structure of the new primitives.
 *
 * What this canNOT cover, honestly stated: click/keyboard interaction and
 * anything post-hydration (a collapse toggle actually flipping, a number field
 * committing on blur). `defaultOpen` is therefore exercised in BOTH states so
 * the collapsed branch is not merely assumed, and the commit paths stay covered
 * by the pure-logic tests plus the Stage 5 browser probes.
 */

const noop = () => {};
/** Pure red as an EditorColor — the control's contract is the document's type. */
const RED = { r: 1, g: 0, b: 0, a: 1 };

describe("shared control shell", () => {
  it("puts every text-ish control on one 32px height with one focus ring", () => {
    // H5: height/padding/border/radius/focus/disabled declared once. If a field
    // stops using the CONTROL constant, its markup loses these together.
    const markups = [
      renderToStaticMarkup(h(NumberField, { label: "Width", value: 100, onCommit: noop })),
      renderToStaticMarkup(
        h(SelectField, { label: "Font", value: "a", options: [{ value: "a", label: "A" }], onCommit: noop }),
      ),
      renderToStaticMarkup(h(ColorField, { label: "Color", value: RED, onCommit: noop })),
    ];
    for (const markup of markups) {
      expect(markup).toContain("h-8");
      expect(markup).toContain("rounded-control");
      expect(markup).toContain("focus-visible:ring-editor-accent/30");
      expect(markup).toContain("disabled:bg-editor-subtle");
    }
  });

  it("keeps the label column wide enough for the longest un-abbreviated label", () => {
    // H6: "Rotation"/"Opacity" spelled out, so the column is 58px not 52px.
    const markup = renderToStaticMarkup(
      h(NumberField, { label: "Rotation", value: 0, onCommit: noop, suffix: "°" }),
    );
    expect(markup).toContain("w-[58px]");
    expect(markup).toContain("Rotation");
  });

  it("marks typed fields so tool shortcuts do not fire while typing", () => {
    // The `isTextInput` contract (domFocus.ts): a number field must not let "R"
    // switch tools mid-value.
    const markup = renderToStaticMarkup(h(NumberField, { label: "Size", value: 12, onCommit: noop }));
    expect(markup).toContain('data-editor-text-input="true"');
  });

  it("uses real disabled semantics rather than a greyed-out look", () => {
    // H24: no dead-looking-but-clickable controls.
    const markup = renderToStaticMarkup(
      h(NumberField, { label: "Width", value: 10, onCommit: noop, disabled: true }),
    );
    expect(markup).toContain("disabled=");
  });
});

describe("numeric pair grid (H25)", () => {
  const row = () =>
    renderToStaticMarkup(
      h(NumberPairRow, {
        first: { label: "X", name: "X position", value: 12, onCommit: noop },
        second: { label: "Y", name: "Y position", value: 34, onCommit: noop },
        unit: "pt",
      }),
    );

  it("lays the pair out in two columns, not two stacked full-width rows", () => {
    expect(row()).toContain("grid-cols-2");
  });

  it("renders both values", () => {
    const markup = row();
    expect(markup).toContain('value="12"');
    expect(markup).toContain('value="34"');
  });

  it("spells the compact label out for screen readers, including its unit", () => {
    // The visible "X" is conventional in a coordinate grid (H6) but is not a
    // usable accessible name; the unit belongs in the name too (H26).
    const markup = row();
    expect(markup).toContain('aria-label="X position (pt)"');
    expect(markup).toContain('aria-label="Y position (pt)"');
    // The decorative one-character label is hidden so it is not announced twice.
    expect(markup).toMatch(/aria-hidden="true"[^>]*>X</);
  });

  it("hosts a pair-level affordance without disturbing the two cells", () => {
    // The slot the aspect-ratio lock (H14) occupies beside W/H.
    const markup = renderToStaticMarkup(
      h(NumberPairRow, {
        first: { label: "W", name: "Width", value: 5, onCommit: noop },
        second: { label: "H", name: "Height", value: 6, onCommit: noop },
        trailing: h("button", { type: "button" }, "lock"),
      }),
    );
    expect(markup).toContain("lock");
    expect(markup).toContain('value="5"');
    expect(markup).toContain('value="6"');
  });
});

describe("segmented control (H10, H11, H44)", () => {
  const items = [
    { id: "bold", label: "Bold", text: "B", pressed: true, onPress: noop },
    { id: "italic", label: "Italic", text: "I", pressed: false, onPress: noop },
  ];

  it("is a labelled group of pressed-state buttons", () => {
    const markup = renderToStaticMarkup(h(SegmentedControl, { label: "Text style", items }));
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Text style"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("conveys the active state with more than one visual channel", () => {
    // H10: not colour alone. The pressed item gets a surface AND a ring.
    const markup = renderToStaticMarkup(h(SegmentedControl, { label: "Text style", items }));
    expect(markup).toContain("ring-editor-accent/40");
    expect(markup).toContain("bg-editor-surface");
  });

  it("names each button even when only an icon is shown", () => {
    const markup = renderToStaticMarkup(
      h(SegmentedControl, {
        label: "Text alignment",
        items: [{ id: "left", label: "Align left", icon: h("svg"), pressed: false, onPress: noop }],
      }),
    );
    expect(markup).toContain('aria-label="Align left"');
  });

  it("explains an unavailable option in its tooltip (H24)", () => {
    const markup = renderToStaticMarkup(
      h(SegmentedControl, {
        label: "Text style",
        items: [
          {
            id: "italic",
            label: "Italic",
            text: "I",
            pressed: false,
            disabled: true,
            reason: "This font has no italic variant",
            onPress: noop,
          },
        ],
      }),
    );
    expect(markup).toContain("disabled=");
    expect(markup).toContain("Italic — This font has no italic variant");
  });
});

describe("collapsible section (H4)", () => {
  it("exposes an expanded control wired to the body it controls", () => {
    const markup = renderToStaticMarkup(
      h(InspectorSection, { title: "Position & size", children: h("p", null, "body") }),
    );
    expect(markup).toContain('aria-expanded="true"');
    const controls = markup.match(/aria-controls="([^"]+)"/);
    expect(controls, "aria-controls not found").not.toBeNull();
    // The referenced element must actually exist, or the relationship is a lie.
    expect(markup).toContain(`id="${controls![1]}"`);
    expect(markup).toContain("body");
  });

  it("uses a real button so collapse is keyboard-operable without extra wiring", () => {
    const markup = renderToStaticMarkup(
      h(InspectorSection, { title: "Text", children: h("p", null, "x") }),
    );
    expect(markup).toMatch(/<button[^>]*aria-expanded/);
  });

  it("hides the body when collapsed but keeps it in the tree", () => {
    // Both halves matter: `hidden` for assistive tech, still-present markup so
    // `aria-controls` resolves and the fields keep their state.
    const markup = renderToStaticMarkup(
      h(InspectorSection, { title: "Advanced", defaultOpen: false, children: h("p", null, "body") }),
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("hidden");
    expect(markup).toContain("body");
  });

  it("shares its title treatment with the static group", () => {
    // H4: one section pattern. Both must render the same title class string.
    const collapsible = renderToStaticMarkup(h(InspectorSection, { title: "T", children: h("i") }));
    const staticGroup = renderToStaticMarkup(h(FieldGroup, { title: "T", children: h("i") }));
    const cls = (m: string) => m.match(/class="([^"]*uppercase[^"]*)"/)?.[1];
    expect(cls(collapsible)).toBeTruthy();
    expect(cls(staticGroup)).toBe(cls(collapsible));
  });
});

describe("slider (H27)", () => {
  it("shows its numeric value with a unit and stays keyboard operable", () => {
    const markup = renderToStaticMarkup(
      h(Slider, { label: "Opacity", value: 80, onCommit: noop, min: 0, max: 100, unit: "%" }),
    );
    expect(markup).toContain('type="range"');
    expect(markup).toContain("80");
    expect(markup).toContain("%");
    // A native range is focusable and arrow-operable; a decorative div is not.
    expect(markup).toContain('max="100"');
  });

  it("gives the range a 32px hit target rather than a 16px track", () => {
    // A native `input[type=range]` with no height is 16px tall in Chrome
    // (measured via CDP). That failed twice over: WCAG 2.5.8 Target Size
    // (Minimum) wants >=24px, and every other Inspector row is 32px, so the
    // Opacity row rendered visibly short. The box is the hit region, so `h-8`
    // fixes both without thickening the visible track.
    const markup = renderToStaticMarkup(
      h(Slider, { label: "Opacity", value: 50, onCommit: noop, min: 0, max: 100 }),
    );
    const rangeTag = markup.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? "";
    expect(rangeTag).toContain('type="range"');
    expect(rangeTag).toContain("h-8");
  });
});

describe("colour control", () => {
  it("shows the value as hex, never as a raw rgba string", () => {
    // The acceptance criterion: no normal property control displays raw rgba.
    // `rgba(1,0,0,1)` is a developer representation; a person edits "#FF0000".
    const markup = renderToStaticMarkup(h(ColorField, { label: "Fill", value: RED, onCommit: noop }));
    expect(markup).toContain("#FF0000");
    expect(markup).not.toMatch(/rgba?\(/);
  });

  it("uses no browser-native colour input anywhere in the row", () => {
    // The acceptance criterion: no critical control relies on a browser-native
    // unstyled picker. `<input type="color">` opens an OS dialog with no
    // opacity, no document palette, and no keyboard behaviour we control.
    const markup = renderToStaticMarkup(h(ColorField, { label: "Fill", value: RED, onCommit: noop }));
    expect(markup).not.toContain('type="color"');
  });

  it("names the trigger with both the property and its current value", () => {
    // A swatch with no accessible name is unusable by a screen reader, and a
    // name of just "Fill" hides what it is set to.
    const markup = renderToStaticMarkup(h(ColorField, { label: "Fill", value: RED, onCommit: noop }));
    expect(markup).toContain('aria-label="Fill: #FF0000"');
  });

  it("announces opacity in the accessible name when the colour is translucent", () => {
    const markup = renderToStaticMarkup(
      h(ColorField, { label: "Fill", value: { ...RED, a: 0.4 }, onCommit: noop }),
    );
    expect(markup).toContain('aria-label="Fill: #FF0000 at 40% opacity"');
  });

  it("declares itself a popover trigger, closed until opened", () => {
    const markup = renderToStaticMarkup(h(ColorField, { label: "Fill", value: RED, onCommit: noop }));
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("says 'no fill' in words rather than showing a misleading swatch", () => {
    // The old control rendered a WHITE swatch for a null fill, so an unfilled
    // shape looked white and touching the picker committed white. The empty
    // state now names itself.
    const markup = renderToStaticMarkup(
      h(ColorField, { label: "Fill", value: null, allowNoFill: true, emptyLabel: "No fill", onCommit: noop }),
    );
    expect(markup).toContain("No fill");
    expect(markup).toContain('aria-label="Fill: No fill"');
  });

  it("uses a caller-supplied empty label, so a stroke does not say 'no fill'", () => {
    const markup = renderToStaticMarkup(
      h(ColorField, { label: "Stroke", value: null, allowNoFill: true, emptyLabel: "No stroke", onCommit: noop }),
    );
    expect(markup).toContain('aria-label="Stroke: No stroke"');
  });

  it("renders exactly one trigger per row, not a swatch plus a parallel field", () => {
    const markup = renderToStaticMarkup(h(ColorField, { label: "Fill", value: RED, onCommit: noop }));
    expect(markup.match(/<button/g) ?? []).toHaveLength(1);
    // No text input in the closed row either: the hex field lives in the popover,
    // so a colour row cannot be edited into an invalid state from the outside.
    expect(markup).not.toContain("<input");
  });
});
