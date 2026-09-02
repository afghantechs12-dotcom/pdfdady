import { describe, expect, it } from "vitest";
import { TOOLBAR_ICONS, toolIcon } from "@/components/editor/toolbarIcons";
import {
  ALL_TOOLBAR_TOOLS,
  TOOLBAR_COMPACT_MAX_WIDTH,
  TOOLBAR_TABLET_MAX_WIDTH,
  overflowTools,
  resolveToolbarMode,
  toolPlacement,
  visibleGroups,
} from "@/components/editor/toolbarLayout";

describe("toolbarIcons — the single icon registry (M6.12)", () => {
  it("registers an icon component for EVERY tool's icon id", () => {
    for (const t of ALL_TOOLBAR_TOOLS) {
      expect(toolIcon(t.icon), `missing icon for tool "${t.id}" (icon id "${t.icon}")`).not.toBeNull();
    }
  });

  it("registered icons are renderable components (functions/objects, not strings)", () => {
    for (const [id, icon] of Object.entries(TOOLBAR_ICONS)) {
      expect(["function", "object"], `icon "${id}"`).toContain(typeof icon);
      expect(icon, `icon "${id}"`).toBeTruthy();
    }
  });

  it("returns null (not a crash) for unknown icon ids", () => {
    expect(toolIcon("does-not-exist")).toBeNull();
  });
});

describe("toolbarLayout — responsive mode resolution (M6.12)", () => {
  it("maps container widths to modes at the canonical breakpoints", () => {
    expect(resolveToolbarMode(320)).toBe("compact");
    expect(resolveToolbarMode(TOOLBAR_COMPACT_MAX_WIDTH - 1)).toBe("compact");
    expect(resolveToolbarMode(TOOLBAR_COMPACT_MAX_WIDTH)).toBe("tablet");
    expect(resolveToolbarMode(TOOLBAR_TABLET_MAX_WIDTH - 1)).toBe("tablet");
    expect(resolveToolbarMode(TOOLBAR_TABLET_MAX_WIDTH)).toBe("desktop");
    // A full-width standalone editor at 1920px affords the labeled desktop row.
    expect(resolveToolbarMode(1920)).toBe("desktop");
  });

  it("treats an unmeasured width as desktop (nothing hidden pre-measurement)", () => {
    expect(resolveToolbarMode(0)).toBe("desktop");
    expect(resolveToolbarMode(-5)).toBe("desktop");
    expect(resolveToolbarMode(NaN)).toBe("desktop");
  });

  /**
   * The launch-polish regression, and the reason these assertions are written
   * against real laptop widths rather than against the constants: the tablet cut
   * was once 960px, so a 1024px viewport resolved to "desktop" and rendered all
   * 22 inline tools plus the ~534px action cluster — about 1596px — into a
   * ~1024px non-wrapping row. The tail was clipped off the right edge: in the
   * DOM, keyboard-reachable, and invisible to a mouse.
   *
   * The premium redesign changed the ROW, not just the numbers: shapes (11) and
   * draw (3) collapsed into 2 labelled cluster triggers, and the zoom stepper +
   * preset select moved to the bottom capsule. That is what makes the labelled
   * row affordable at laptop widths — see TOOLBAR_TABLET_MAX_WIDTH's comment for
   * the per-mode measurements.
   */
  it("does not claim a mode at widths that cannot fit that mode's row", () => {
    // The labelled row needs 1328px of container (1060.3px of scroller content
    // plus the 267.3px pinned cluster, re-measured in the premium visual pass);
    // below it, icons.
    expect(resolveToolbarMode(1024)).not.toBe("desktop");
    expect(resolveToolbarMode(1200)).not.toBe("desktop");
    // And the compact row's own floor still holds.
    expect(resolveToolbarMode(700)).toBe("compact");
  });

  it("puts the labelled row on the laptop widths it was measured to fit", () => {
    // The point of the redesign: 1366 and 1440 are the commonest laptop widths
    // and the reference design's own scale. Before this change both rendered a
    // bare icon row, because labels required a 1900px container.
    expect(TOOLBAR_TABLET_MAX_WIDTH).toBeLessThanOrEqual(1366);
    expect(resolveToolbarMode(1366)).toBe("desktop");
    expect(resolveToolbarMode(1440)).toBe("desktop");
    expect(resolveToolbarMode(1920)).toBe("desktop");
  });

  it("keeps the compact cut above the width the tablet row needs", () => {
    // Measured from the real editor (scripts/editor-audit.mjs): the toolbar root
    // spans the viewport, and the scrollable tool row gets `container - 257px`
    // after the pinned undo/redo/Export cluster.
    //
    // This assertion is the guard on a bug this file previously ENCODED. The cut
    // was first set to 760 — the width of the tablet row's tools alone, ignoring
    // the pinned cluster — and this test asserted `768 -> tablet`, so an
    // overflowing 13-icon row on every viewport from 768px up was "covered by a
    // passing test". A 768px tablet must therefore get the COMPACT row.
    //
    // RE-MEASURED in P1 (Phase C3). The cut was 1018–1020, which fitted a 1024px
    // viewport with ~6px to spare. Raising the labelled controls to a 38px
    // minimum and widening Export's padding consumed that slack: at 1024px the
    // row scrolled, at 1040px it fitted. So 1024px — iPad landscape, a target
    // viewport — now takes the compact row, and the bound rises with the metrics
    // rather than leaving a scrolling toolbar behind a passing test.
    //
    // RE-MEASURED AGAIN in the premium visual pass: the pinned undo/redo/Open/
    // Export cluster joined the icon row's 44px control box (it had been 38px in
    // every mode), which widened it by ~6px and pushed the tablet row back into
    // overflow at 1040. Measured fit is now 1045.
    expect(TOOLBAR_COMPACT_MAX_WIDTH).toBeGreaterThanOrEqual(1045);
    expect(resolveToolbarMode(390)).toBe("compact");
    expect(resolveToolbarMode(768)).toBe("compact");
    expect(resolveToolbarMode(1010)).toBe("compact");
    expect(resolveToolbarMode(1024)).toBe("compact");
    expect(resolveToolbarMode(1045)).toBe("tablet");
  });
});

describe("toolbarLayout — active-tool placement (M6.12)", () => {
  it("every tool is represented in every mode (inline or overflow, never lost)", () => {
    for (const mode of ["desktop", "tablet", "compact"] as const) {
      const inline = new Set(visibleGroups(mode).flatMap((g) => g.tools.map((t) => t.id)));
      const over = new Set(overflowTools(mode).map((t) => t.id));
      for (const t of ALL_TOOLBAR_TOOLS) {
        const placement = toolPlacement(mode, t.id);
        expect(placement === "inline" ? inline.has(t.id) : over.has(t.id), `${mode}/${t.id}`).toBe(true);
        // And never both.
        expect(inline.has(t.id) && over.has(t.id), `${mode}/${t.id} duplicated`).toBe(false);
      }
    }
  });

  it("desktop places everything inline; compact overflows crop and path", () => {
    // `toolPlacement` models the PRIORITY cut, which is what the icon modes
    // render from. The labelled row's clustering is a separate presentation
    // decision (see labelledGroups/labelledOverflowTools in toolbarLayout.test),
    // so priority-3 shapes are still "inline" here even though the labelled row
    // reaches them through the Add Shape menu.
    for (const t of ALL_TOOLBAR_TOOLS) expect(toolPlacement("desktop", t.id)).toBe("inline");
    expect(toolPlacement("compact", "crop")).toBe("overflow");
    expect(toolPlacement("compact", "path")).toBe("overflow");
    expect(toolPlacement("compact", "select")).toBe("inline");
    expect(toolPlacement("tablet", "star")).toBe("overflow");
    expect(toolPlacement("tablet", "crop")).toBe("inline");
  });
});
