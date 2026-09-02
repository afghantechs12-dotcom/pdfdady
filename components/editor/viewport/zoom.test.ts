import { describe, expect, it } from "vitest";
import {
  CANVAS_BOTTOM_RESERVE,
  FIT_PADDING,
  FLOATING_CONTROLS_GAP,
  FLOATING_CONTROLS_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_PRESETS,
  centeredPan,
  clampZoom,
  fitHeightZoom,
  fitPageZoom,
  fitViewport,
  fitWidthZoom,
  fitZoom,
  matchingPreset,
  nextZoomStep,
  prevZoomStep,
  usableFitArea,
  zoomAboutPoint,
} from "./zoom";

describe("zoom presets + clamp", () => {
  it("the preset ladder is 10%…800%, sorted, within the clamp range", () => {
    expect(ZOOM_PRESETS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_PRESETS[ZOOM_PRESETS.length - 1]).toBe(MAX_ZOOM);
    const sorted = [...ZOOM_PRESETS].sort((a, b) => a - b);
    expect([...ZOOM_PRESETS]).toEqual(sorted);
    expect(ZOOM_PRESETS).toEqual([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8]);
  });

  it("clampZoom clamps into [0.1, 8] and defaults non-finite to 1", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });
});

describe("nextZoomStep / prevZoomStep", () => {
  it("steps up to the next preset from a preset value", () => {
    expect(nextZoomStep(1)).toBe(1.25);
    expect(nextZoomStep(0.1)).toBe(0.25);
    expect(nextZoomStep(4)).toBe(8);
  });

  it("steps up to the nearest preset above a custom value", () => {
    expect(nextZoomStep(0.6)).toBe(0.75);
    expect(nextZoomStep(1.01)).toBe(1.25);
    expect(nextZoomStep(7.9)).toBe(8);
  });

  it("saturates at MAX_ZOOM", () => {
    expect(nextZoomStep(8)).toBe(8);
    expect(nextZoomStep(50)).toBe(8);
  });

  it("steps down to the previous preset from a preset value", () => {
    expect(prevZoomStep(1)).toBe(0.75);
    expect(prevZoomStep(8)).toBe(4);
    expect(prevZoomStep(0.25)).toBe(0.1);
  });

  it("steps down to the nearest preset below a custom value", () => {
    expect(prevZoomStep(0.6)).toBe(0.5);
    expect(prevZoomStep(2.9)).toBe(2);
  });

  it("saturates at MIN_ZOOM", () => {
    expect(prevZoomStep(0.1)).toBe(0.1);
    expect(prevZoomStep(0.001)).toBe(0.1);
  });

  it("is tolerant of float noise around a preset", () => {
    expect(nextZoomStep(1 + 1e-9)).toBe(1.25);
    expect(prevZoomStep(1 - 1e-9)).toBe(0.75);
  });
});

describe("matchingPreset", () => {
  it("returns the preset for exact (and epsilon-close) values", () => {
    expect(matchingPreset(1)).toBe(1);
    expect(matchingPreset(1 + 1e-9)).toBe(1);
    expect(matchingPreset(8)).toBe(8);
  });

  it("returns null for custom zooms", () => {
    expect(matchingPreset(1.1)).toBeNull();
    expect(matchingPreset(0.33)).toBeNull();
  });
});

describe("fit computations", () => {
  it("fitWidthZoom fills the container width minus padding", () => {
    // 1000px container, 24px padding each side → 952 usable for a 476pt page → 2x.
    expect(fitWidthZoom(1000, 476, 24)).toBe(2);
  });

  it("fitHeightZoom fills the container height minus padding", () => {
    expect(fitHeightZoom(500, 226, 24)).toBe(2);
  });

  it("fitPageZoom takes the smaller of the two fits", () => {
    const container = { width: 1000, height: 500 };
    const page = { width: 476, height: 452 };
    // fit-width would be 2, fit-height (452 → 452px usable) is 1 → fit page = 1.
    expect(fitPageZoom(container, page, 24)).toBe(1);
  });

  it("fitZoom dispatches to the right mode", () => {
    const container = { width: 1000, height: 500 };
    const page = { width: 476, height: 226 };
    expect(fitZoom("fit-width", container, page, 24)).toBe(2);
    expect(fitZoom("fit-height", container, page, 24)).toBe(2);
    expect(fitZoom("fit-page", container, page, 24)).toBe(2);
  });

  it("clamps to the zoom range", () => {
    expect(fitWidthZoom(100000, 10, 0)).toBe(MAX_ZOOM);
    expect(fitWidthZoom(60, 10000, 24)).toBe(MIN_ZOOM);
  });

  it("degenerate inputs fall back to 1", () => {
    expect(fitWidthZoom(10, 100, 24)).toBe(1); // container smaller than the padding
    expect(fitWidthZoom(1000, 0, 24)).toBe(1);
    expect(fitWidthZoom(NaN, 100, 24)).toBe(1);
  });

  it("uses the default FIT_PADDING when none is given", () => {
    expect(fitWidthZoom(476 + 2 * FIT_PADDING, 476)).toBe(1);
  });
});

describe("centeredPan", () => {
  it("centers the page when it fits", () => {
    const pan = centeredPan({ width: 1000, height: 800 }, { width: 400, height: 300 }, 1, 24);
    expect(pan).toEqual({ x: 300, y: 250 });
  });

  it("never goes above/left of the padding when the page overflows", () => {
    const pan = centeredPan({ width: 400, height: 300 }, { width: 1000, height: 1000 }, 1, 24);
    expect(pan).toEqual({ x: 24, y: 24 });
  });
});

describe("zoomAboutPoint", () => {
  it("keeps the page point under the focus stationary", () => {
    const viewport = { zoom: 1, pan: { x: 100, y: 50 } };
    const focus = { x: 400, y: 300 };
    // Page point under focus: (focus - pan) / zoom = (300, 250).
    const next = zoomAboutPoint(viewport, focus, 2);
    expect(next.zoom).toBe(2);
    const pageUnderFocus = {
      x: (focus.x - next.pan.x) / next.zoom,
      y: (focus.y - next.pan.y) / next.zoom,
    };
    expect(pageUnderFocus.x).toBeCloseTo(300, 9);
    expect(pageUnderFocus.y).toBeCloseTo(250, 9);
  });

  it("clamps the requested zoom", () => {
    const viewport = { zoom: 1, pan: { x: 0, y: 0 } };
    expect(zoomAboutPoint(viewport, { x: 0, y: 0 }, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomAboutPoint(viewport, { x: 0, y: 0 }, 0).zoom).toBe(MIN_ZOOM);
  });

  it("is a no-op at the same zoom", () => {
    const viewport = { zoom: 2, pan: { x: 12, y: 34 } };
    expect(zoomAboutPoint(viewport, { x: 500, y: 500 }, 2)).toEqual(viewport);
  });
});

/*
 * P1 Phase I: the floating capsule's bottom reserve.
 *
 * The shipped build laid the page out under the capsule — the Phase I probe
 * measured the page bottom running 66px behind the bar at Fit Page. These pin
 * both halves of the fix, because getting one right and the other wrong still
 * hides content (zoom-only leaves the page centred in the full height; pan-only
 * pushes an exactly-fitting page off the top).
 */
describe("usableFitArea — the bottom strip a fit mode may not use", () => {
  it("subtracts the reserve from the height only", () => {
    const area = usableFitArea({ width: 1000, height: 800 }, 60);
    expect(area).toEqual({ width: 1000, height: 740 });
  });

  it("leaves the width alone — the capsule is centred, not full-width", () => {
    // Taking width for a narrow centred bar would shrink the page for nothing.
    expect(usableFitArea({ width: 1000, height: 800 }, 60).width).toBe(1000);
  });

  it("floors at a positive height for a container shorter than the reserve", () => {
    expect(usableFitArea({ width: 500, height: 20 }, 66).height).toBe(1);
    expect(usableFitArea({ width: 500, height: 0 }, 66).height).toBe(1);
  });

  it("ignores a negative reserve rather than growing the usable area", () => {
    expect(usableFitArea({ width: 500, height: 400 }, -50).height).toBe(400);
  });

  it("derives the reserve from the capsule's real layout budget", () => {
    // 54px capsule (border+padding+group inset+36px control, both sides) + 12px gap.
    expect(FLOATING_CONTROLS_HEIGHT).toBe(54);
    expect(FLOATING_CONTROLS_GAP).toBe(12);
    expect(CANVAS_BOTTOM_RESERVE).toBe(FLOATING_CONTROLS_HEIGHT + FLOATING_CONTROLS_GAP);
  });
});

describe("fitViewport — zoom AND pan, both respecting the reserve", () => {
  it("keeps the fitted page clear of the reserved strip at fit-page", () => {
    const container = { width: 1000, height: 800 };
    const page = { width: 600, height: 800 };
    const vp = fitViewport("fit-page", container, page, FIT_PADDING);
    const pageBottom = vp.pan.y + page.height * vp.zoom;
    // The whole page, including its bottom edge, stays above the capsule strip.
    expect(pageBottom).toBeLessThanOrEqual(container.height - CANVAS_BOTTOM_RESERVE + 1e-6);
    /*
     * Pinned against a LITERAL clearance as well, not only against the constant.
     * Comparing solely to `CANVAS_BOTTOM_RESERVE` makes the assertion trivially
     * satisfiable by setting the reserve to 0 — mutation testing proved exactly
     * that, so the guard now also demands the real ~54px bar plus its gap fits
     * in the gap that is left. That is the fact the user experiences.
     */
    expect(container.height - pageBottom).toBeGreaterThanOrEqual(60);
  });

  it("would leave the page under the bar if the reserve were not applied", () => {
    // The control case: the pre-Phase-I behaviour was `fitZoom`+`centeredPan` on
    // the FULL container, which puts the page bottom flush with the canvas
    // bottom — i.e. entirely behind a 54px capsule.
    const container = { width: 1000, height: 800 };
    const page = { width: 600, height: 800 };
    const noReserve = fitViewport("fit-page", container, page, FIT_PADDING, 0);
    const bottomNoReserve = noReserve.pan.y + page.height * noReserve.zoom;
    expect(container.height - bottomNoReserve).toBeLessThan(60);

    const withReserve = fitViewport("fit-page", container, page, FIT_PADDING);
    const bottomWithReserve = withReserve.pan.y + page.height * withReserve.zoom;
    // The reserve genuinely moves the page up; it is not a no-op rename.
    expect(bottomWithReserve).toBeLessThan(bottomNoReserve);
  });

  it("centres the page inside the usable area, not the full container", () => {
    const container = { width: 1000, height: 800 };
    const page = { width: 200, height: 100 };
    const vp = fitViewport("fit-page", container, page, FIT_PADDING);
    const area = usableFitArea(container);
    expect(vp.pan.y).toBeCloseTo((area.height - page.height * vp.zoom) / 2, 9);
    expect(vp.pan.x).toBeCloseTo((area.width - page.width * vp.zoom) / 2, 9);
  });

  it("never pushes the page above the padding (the pan-only failure mode)", () => {
    const container = { width: 300, height: 200 };
    const page = { width: 2000, height: 3000 };
    const vp = fitViewport("fit-page", container, page, FIT_PADDING);
    expect(vp.pan.y).toBeGreaterThanOrEqual(FIT_PADDING);
    expect(vp.pan.x).toBeGreaterThanOrEqual(FIT_PADDING);
  });

  it("agrees with fitZoom computed on the usable area, for every mode", () => {
    const container = { width: 1200, height: 900 };
    const page = { width: 595, height: 842 };
    for (const mode of ["fit-page", "fit-width", "fit-height"] as const) {
      const vp = fitViewport(mode, container, page, FIT_PADDING);
      expect(vp.zoom).toBeCloseTo(fitZoom(mode, usableFitArea(container), page, FIT_PADDING), 9);
    }
  });

  it("leaves fit-width driven by width, so the reserve does not shrink it", () => {
    const container = { width: 1000, height: 800 };
    const page = { width: 500, height: 500 };
    const vp = fitViewport("fit-width", container, page, FIT_PADDING);
    expect(vp.zoom).toBeCloseTo(fitWidthZoom(container.width, page.width, FIT_PADDING), 9);
  });

  it("returns a clamped zoom for degenerate containers rather than NaN", () => {
    const vp = fitViewport("fit-page", { width: 0, height: 0 }, { width: 100, height: 100 });
    expect(Number.isFinite(vp.zoom)).toBe(true);
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(vp.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(Number.isFinite(vp.pan.x)).toBe(true);
    expect(Number.isFinite(vp.pan.y)).toBe(true);
  });
});
