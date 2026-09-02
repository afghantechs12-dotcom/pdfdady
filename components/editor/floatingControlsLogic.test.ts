import { describe, expect, it } from "vitest";
import {
  CAPSULE_BREAKPOINTS,
  FIT_MODE_LABELS,
  canGoNextPage,
  canGoPrevPage,
  canZoomIn,
  canZoomOut,
  isPanPressed,
  isSelectPressed,
  pageNavDisabledReason,
  pageReadout,
  resolveCapsuleDensity,
  resolveCapsulePointerMode,
  resolveCapsuleVisibility,
  resolvePageEntry,
  zoomDisabledReason,
  zoomReadout,
  zoomTriggerAccessibleName,
  zoomTriggerLabel,
  zoomTriggerLabelCompact,
} from "@/components/editor/floatingControlsLogic";
import { ALL_EDITOR_TOOLS } from "@/components/editor/editorTypes";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_PRESETS, nextZoomStep, prevZoomStep } from "@/components/editor/viewport/zoom";

describe("floatingControlsLogic — zoom stepper availability", () => {
  it("disables zoom out exactly at the minimum, not merely near it", () => {
    expect(canZoomOut(MIN_ZOOM)).toBe(false);
    expect(canZoomOut(MIN_ZOOM + 0.01)).toBe(true);
    expect(canZoomOut(1)).toBe(true);
  });

  it("disables zoom in exactly at the maximum", () => {
    expect(canZoomIn(MAX_ZOOM)).toBe(false);
    expect(canZoomIn(MAX_ZOOM - 0.01)).toBe(true);
    expect(canZoomIn(1)).toBe(true);
  });

  it("never enables a step the clamp cannot take (below min / above max)", () => {
    expect(canZoomOut(MIN_ZOOM - 1)).toBe(false);
    expect(canZoomIn(MAX_ZOOM + 1)).toBe(false);
  });

  it("treats non-finite zoom as no step available rather than throwing", () => {
    expect(canZoomOut(Number.NaN)).toBe(false);
    expect(canZoomIn(Number.NaN)).toBe(false);
  });

  /**
   * The disabled state must agree with the ladder the button actually calls.
   * A button enabled where the step is a no-op is a dead control, and a button
   * disabled where the step would move is a lost capability.
   */
  it("agrees with the real zoom ladder at both ends", () => {
    expect(prevZoomStep(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(canZoomOut(MIN_ZOOM)).toBe(false);
    expect(nextZoomStep(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(canZoomIn(MAX_ZOOM)).toBe(false);
    for (const preset of ZOOM_PRESETS) {
      if (preset > MIN_ZOOM) expect(canZoomOut(preset)).toBe(true);
      if (preset < MAX_ZOOM) expect(canZoomIn(preset)).toBe(true);
    }
  });

  it("states a real reason when a stepper is disabled, and none when enabled", () => {
    expect(zoomDisabledReason("out", MIN_ZOOM)).toBe("Minimum zoom (10%)");
    expect(zoomDisabledReason("in", MAX_ZOOM)).toBe("Maximum zoom (800%)");
    expect(zoomDisabledReason("out", 1)).toBeNull();
    expect(zoomDisabledReason("in", 1)).toBeNull();
  });
});

describe("floatingControlsLogic — zoom readout", () => {
  it("renders the zoom as a whole percentage", () => {
    expect(zoomReadout(1)).toBe(100);
    expect(zoomReadout(0.78)).toBe(78);
    expect(zoomReadout(2)).toBe(200);
    expect(zoomReadout(8)).toBe(800);
  });

  it("never renders 0% for a tiny but non-zero zoom", () => {
    expect(zoomReadout(0.001)).toBe(1);
    expect(zoomReadout(0.004)).toBe(1);
  });

  it("falls back to 100 for nonsense rather than rendering NaN%", () => {
    expect(zoomReadout(Number.NaN)).toBe(100);
    expect(zoomReadout(0)).toBe(100);
    expect(zoomReadout(-1)).toBe(100);
  });
});

describe("floatingControlsLogic — fit mode display", () => {
  it("names the active fit mode on the trigger, with the live percentage", () => {
    expect(zoomTriggerLabel(0.78, "fit-page")).toBe("Fit page (78%)");
    expect(zoomTriggerLabel(1.4, "fit-width")).toBe("Fit width (140%)");
    expect(zoomTriggerLabel(0.5, "fit-height")).toBe("Fit height (50%)");
  });

  /**
   * The distinction the pre-Phase-I capsule could not express: a percentage
   * alone cannot tell "I chose this zoom" from "a fit mode computed it and will
   * recompute it on the next resize".
   */
  it("shows the percentage alone when the zoom is manual", () => {
    expect(zoomTriggerLabel(0.78, null)).toBe("78%");
    expect(zoomTriggerLabel(1, null)).toBe("100%");
  });

  it("keeps the compact trigger to the percentage only", () => {
    expect(zoomTriggerLabelCompact(0.78)).toBe("78%");
    expect(zoomTriggerLabelCompact(1)).toBe("100%");
  });

  it("states both zoom and fit mode in the accessible name", () => {
    expect(zoomTriggerAccessibleName(0.78, "fit-page")).toBe("Zoom level: 78%, Fit page");
    expect(zoomTriggerAccessibleName(0.78, null)).toBe("Zoom level: 78%");
  });

  /** WCAG 2.5.3: the visible label must be contained in the spoken name. */
  it("contains the visible label inside the accessible name", () => {
    for (const fit of [null, "fit-page", "fit-width", "fit-height"] as const) {
      const visible = zoomTriggerLabel(0.78, fit);
      const spoken = zoomTriggerAccessibleName(0.78, fit);
      const parts = visible.replace(/[()]/g, "").split(" ").filter(Boolean);
      for (const part of parts) expect(spoken).toContain(part);
    }
  });

  it("labels every fit mode the viewport actually supports", () => {
    expect(Object.keys(FIT_MODE_LABELS).sort()).toEqual(["fit-height", "fit-page", "fit-width"]);
  });
});

describe("floatingControlsLogic — page navigation availability", () => {
  it("disables Previous on the first page and Next on the last", () => {
    expect(canGoPrevPage(1, 56)).toBe(false);
    expect(canGoNextPage(1, 56)).toBe(true);
    expect(canGoPrevPage(56, 56)).toBe(true);
    expect(canGoNextPage(56, 56)).toBe(false);
  });

  it("enables both in the middle of a document", () => {
    expect(canGoPrevPage(3, 56)).toBe(true);
    expect(canGoNextPage(3, 56)).toBe(true);
  });

  it("disables both for a single-page document", () => {
    expect(canGoPrevPage(1, 1)).toBe(false);
    expect(canGoNextPage(1, 1)).toBe(false);
  });

  it("states why navigation is unavailable, and nothing when it is", () => {
    expect(pageNavDisabledReason("prev", 1, 56)).toBe("Already on the first page");
    expect(pageNavDisabledReason("next", 56, 56)).toBe("Already on the last page");
    expect(pageNavDisabledReason("prev", 1, 1)).toBe("This document has one page");
    expect(pageNavDisabledReason("next", 1, 1)).toBe("This document has one page");
    expect(pageNavDisabledReason("prev", 3, 56)).toBeNull();
    expect(pageNavDisabledReason("next", 3, 56)).toBeNull();
  });
});

describe("floatingControlsLogic — page readout", () => {
  it("formats the 1-based page over the total", () => {
    expect(pageReadout(3, 56)).toBe("3 / 56");
    expect(pageReadout(1, 1)).toBe("1 / 1");
  });

  /** A transient 0 (active page id not yet in the list) is not a real state. */
  it("never renders page 0 or a page past the end", () => {
    expect(pageReadout(0, 12)).toBe("1 / 12");
    expect(pageReadout(-4, 12)).toBe("1 / 12");
    expect(pageReadout(99, 12)).toBe("12 / 12");
  });

  it("survives a degenerate page count", () => {
    expect(pageReadout(1, 0)).toBe("1 / 1");
    expect(pageReadout(1, Number.NaN)).toBe("1 / 1");
  });
});

describe("floatingControlsLogic — direct page entry", () => {
  it("accepts an in-range page", () => {
    expect(resolvePageEntry("12", 56)).toBe(12);
    expect(resolvePageEntry("1", 56)).toBe(1);
    expect(resolvePageEntry("56", 56)).toBe(56);
  });

  it("clamps out-of-range entry into the document instead of rejecting it", () => {
    expect(resolvePageEntry("0", 56)).toBe(1);
    expect(resolvePageEntry("999", 56)).toBe(56);
  });

  it("rejects entry that is not a number at all", () => {
    expect(resolvePageEntry("", 56)).toBeNull();
    expect(resolvePageEntry("abc", 56)).toBeNull();
  });
});

describe("floatingControlsLogic — responsive density", () => {
  it("resolves the three densities at their boundaries", () => {
    expect(resolveCapsuleDensity(1200)).toBe("full");
    expect(resolveCapsuleDensity(CAPSULE_BREAKPOINTS.full)).toBe("full");
    expect(resolveCapsuleDensity(CAPSULE_BREAKPOINTS.full - 1)).toBe("medium");
    expect(resolveCapsuleDensity(CAPSULE_BREAKPOINTS.medium)).toBe("medium");
    expect(resolveCapsuleDensity(CAPSULE_BREAKPOINTS.medium - 1)).toBe("compact");
    expect(resolveCapsuleDensity(320)).toBe("compact");
  });

  it("assumes the full layout before measurement rather than the phone layout", () => {
    expect(resolveCapsuleDensity(Number.NaN)).toBe("full");
  });

  /**
   * The invariant that makes the capsule worth having: zoom and page navigation
   * are why it exists, so no width may remove them.
   */
  it("never drops zoom or page navigation at any density", () => {
    for (const density of ["full", "medium", "compact"] as const) {
      const v = resolveCapsuleVisibility(density);
      expect(v.zoom).toBe(true);
      expect(v.pages).toBe(true);
    }
  });

  it("drops the duplicated pointer pair before anything essential", () => {
    expect(resolveCapsuleVisibility("full").pointerMode).toBe(true);
    expect(resolveCapsuleVisibility("medium").pointerMode).toBe(false);
    expect(resolveCapsuleVisibility("compact").pointerMode).toBe(false);
  });

  it("keeps the fit capability at every density even where the button is cut", () => {
    // The compact layout drops the standalone Fit button, but the fit modes stay
    // reachable through the zoom menu — a narrower control set, not a lost one.
    expect(resolveCapsuleVisibility("compact").fitButton).toBe(false);
    expect(resolveCapsuleVisibility("compact").zoom).toBe(true);
    expect(resolveCapsuleVisibility("full").fitButton).toBe(true);
  });

  it("only names the fit mode on the trigger where there is room", () => {
    expect(resolveCapsuleVisibility("full").fitModeOnTrigger).toBe(true);
    expect(resolveCapsuleVisibility("medium").fitModeOnTrigger).toBe(false);
    expect(resolveCapsuleVisibility("compact").fitModeOnTrigger).toBe(false);
  });

  it("monotonically removes controls as width shrinks — never re-adds one", () => {
    const order = ["full", "medium", "compact"] as const;
    const keys = ["pointerMode", "zoom", "pages", "fitButton", "inspector"] as const;
    for (const key of keys) {
      let seenFalse = false;
      for (const density of order) {
        const on = resolveCapsuleVisibility(density)[key];
        if (!on) seenFalse = true;
        else expect(seenFalse).toBe(false);
      }
    }
  });
});

describe("floatingControlsLogic — pointer-mode truthfulness", () => {
  /*
   * The defect these tests exist for: the capsule rendered Select as
   * `active={!panActive}`, so EVERY tool that was not Hand made Select report
   * itself pressed — visually and in `aria-pressed`. Measured in a real browser:
   * Rectangle active, a drag drawing a rectangle, and the bottom bar still said
   * "Select tool (V)" was the pressed control.
   */
  it("presses Select only for the select tool", () => {
    expect(isSelectPressed("select")).toBe(true);
    expect(resolveCapsulePointerMode("select")).toBe("select");
  });

  it("presses Hand only for the hand tool", () => {
    expect(isPanPressed("hand")).toBe(true);
    expect(resolveCapsulePointerMode("hand")).toBe("hand");
  });

  it("presses NEITHER while a shape tool is active — the old !panActive bug", () => {
    for (const tool of ["rect", "roundedRect", "ellipse", "circle", "triangle", "star"]) {
      expect(isSelectPressed(tool)).toBe(false);
      expect(isPanPressed(tool)).toBe(false);
      expect(resolveCapsulePointerMode(tool)).toBe("other");
    }
  });

  it("presses NEITHER while Draw, Eraser or Highlight is active", () => {
    for (const tool of ["draw", "eraser", "highlight", "path"]) {
      expect(isSelectPressed(tool)).toBe(false);
      expect(isPanPressed(tool)).toBe(false);
    }
  });

  it("presses NEITHER while Text or Image placement is active", () => {
    for (const tool of ["text", "image", "signature", "annotation"]) {
      expect(isSelectPressed(tool)).toBe(false);
      expect(isPanPressed(tool)).toBe(false);
    }
  });

  it("never reports two pressed pointer-mode buttons, for ANY canonical tool", () => {
    // The invariant, over the real tool union rather than a sample: exactly one
    // interaction mode is current, so the pair can show at most one pressed.
    for (const tool of ALL_EDITOR_TOOLS) {
      const both = isSelectPressed(tool) && isPanPressed(tool);
      expect(both).toBe(false);
    }
  });

  it("classifies every canonical tool without falling over", () => {
    for (const tool of ALL_EDITOR_TOOLS) {
      expect(["select", "hand", "other"]).toContain(resolveCapsulePointerMode(tool));
    }
    // Exactly one tool maps to each pointer mode — if a second "select"-ish tool
    // is ever added, this fails rather than silently pressing two buttons.
    expect(ALL_EDITOR_TOOLS.filter((t) => isSelectPressed(t))).toEqual(["select"]);
    expect(ALL_EDITOR_TOOLS.filter((t) => isPanPressed(t))).toEqual(["hand"]);
  });

  it("treats an unknown tool id as neither, not as Select", () => {
    // Degrading to "Select is pressed" is how the original bug read; an
    // unrecognised mode must not be claimed by a button that does not own it.
    expect(isSelectPressed("some-future-tool")).toBe(false);
    expect(isPanPressed("")).toBe(false);
    expect(resolveCapsulePointerMode("crop")).toBe("other");
  });
});
