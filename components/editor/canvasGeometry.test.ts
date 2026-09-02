import { describe, expect, it } from "vitest";

import {
  DRAWER_VIEWPORT_FRACTION,
  INSPECTOR_DOCK_WIDTH,
  LEFT_RAIL_COLLAPSED_WIDTH,
  LEFT_RAIL_WIDTH,
  inspectorDrawerWidth,
  isInspectorVisible,
  preserveInspectorVisibility,
  usableCanvasWidth,
} from "@/components/editor/canvasGeometry";
import {
  PANEL_BREAKPOINTS,
  resolvePanelLayout,
  resolvePanelMode,
  resolveLeftRailWidth,
} from "@/components/editor/editorPanelLayout";

/** The shipped frame: expanded rail, Inspector in some presentation. */
const frame = (containerWidth: number, inspector: "docked" | "drawer" | "closed") =>
  usableCanvasWidth({ containerWidth, railWidth: LEFT_RAIL_WIDTH, inspector });

/*
 * Expectations are DERIVED from the two shipped constants rather than written as
 * literals. The rail widened from 176px to 180px in the premium pass (P4, to fit
 * "Pages / Layers / History" without an ellipsis) and the literals silently
 * became wrong by 4px each — a deliberate width change should not read as a
 * broken contract, while the contract itself (subtract exactly the chrome that
 * covers the page, never invert) still has to hold exactly.
 */
const docked = (w: number) => w - LEFT_RAIL_WIDTH - INSPECTOR_DOCK_WIDTH;
const railOnly = (w: number) => w - LEFT_RAIL_WIDTH;

describe("usableCanvasWidth", () => {
  it("subtracts the rail and the docked Inspector", () => {
    expect(frame(1200, "docked")).toBe(docked(1200));
    expect(frame(1280, "docked")).toBe(docked(1280));
    expect(frame(1366, "docked")).toBe(docked(1366));
    expect(frame(1440, "docked")).toBe(docked(1440));
    expect(frame(1600, "docked")).toBe(docked(1600));
    // Concretely, at the shipped 180px rail + 320px dock:
    expect(frame(1200, "docked")).toBe(700);
  });

  it("counts an open DRAWER against the canvas, because it covers the page", () => {
    // This is the reading the old proxy test lacked. Layout width says 1019px;
    // 320px of it is underneath the drawer, so the page cannot use it.
    expect(frame(1199, "drawer")).toBe(docked(1199));
    expect(frame(1199, "closed")).toBe(railOnly(1199));
  });

  it("uses the drawer's real CSS width on narrow screens (min(320px, 88vw))", () => {
    expect(inspectorDrawerWidth(1000)).toBe(INSPECTOR_DOCK_WIDTH);
    // 390px phone: 88vw = 343.2, which is narrower than 320? No — it is wider,
    // so the 320px cap applies. At 300px the fraction wins.
    expect(inspectorDrawerWidth(390)).toBe(INSPECTOR_DOCK_WIDTH);
    expect(inspectorDrawerWidth(300)).toBeCloseTo(300 * DRAWER_VIEWPORT_FRACTION, 5);
  });

  it("never returns a negative width, however cramped", () => {
    expect(usableCanvasWidth({ containerWidth: 200, railWidth: 176, inspector: "docked" })).toBe(0);
    expect(usableCanvasWidth({ containerWidth: 0, railWidth: 176, inspector: "closed" })).toBe(0);
    expect(usableCanvasWidth({ containerWidth: Number.NaN, railWidth: 0, inspector: "closed" })).toBe(0);
  });

  it("gives the canvas the rail's pixels back when the rail collapses", () => {
    const expanded = usableCanvasWidth({ containerWidth: 1366, railWidth: LEFT_RAIL_WIDTH, inspector: "docked" });
    const collapsed = usableCanvasWidth({
      containerWidth: 1366,
      railWidth: LEFT_RAIL_COLLAPSED_WIDTH,
      inspector: "docked",
    });
    expect(collapsed - expanded).toBe(LEFT_RAIL_WIDTH - LEFT_RAIL_COLLAPSED_WIDTH);
  });
});

describe("canvas width monotonicity — THE contract", () => {
  /*
   * The regression in one line: viewport +1px, canvas -319px, at exactly 1200.
   * These tests are densely sampled around that boundary because a threshold bug
   * is invisible at coarse sample points — the old suite checked 1440/1536/1600
   * and never looked at 1199/1200.
   */
  it("does not shrink the canvas across the dock boundary when the Inspector is HIDDEN", () => {
    for (let w = PANEL_BREAKPOINTS.docked - 10; w <= PANEL_BREAKPOINTS.docked + 10; w++) {
      const before = frame(w, "closed");
      const after = frame(w + 1, "closed");
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it("does not shrink the canvas across the dock boundary when the Inspector is SHOWING", () => {
    // Showing means "drawer below the threshold, dock at or above it" — the same
    // panel, presented the way each width can present it.
    const showing = (w: number) => frame(w, w >= PANEL_BREAKPOINTS.docked ? "docked" : "drawer");
    for (let w = PANEL_BREAKPOINTS.docked - 10; w <= PANEL_BREAKPOINTS.docked + 10; w++) {
      expect(showing(w + 1)).toBeGreaterThanOrEqual(showing(w));
    }
    // And the specific measured pair from the bug report.
    expect(showing(1200)).toBeGreaterThanOrEqual(showing(1199));
  });

  it("is monotonic across EVERY pixel from 320 to 2560, both visibility states", () => {
    for (const visible of [false, true]) {
      let prev = -Infinity;
      for (let w = 320; w <= 2560; w++) {
        const mode = resolvePanelMode(w);
        const inspector = !visible ? "closed" : mode === "docked" ? "docked" : "drawer";
        const usable = frame(w, inspector);
        expect(usable).toBeGreaterThanOrEqual(prev);
        prev = usable;
      }
    }
  });

  it("MUTATION: the old always-dock policy violates monotonicity at 1200", () => {
    // Proves these tests can actually fail. This models the shipped behaviour —
    // the Inspector appears because the width crossed the threshold — and the
    // canvas loses 319px for one pixel of gain.
    const oldPolicy = (w: number) =>
      frame(w, resolvePanelMode(w) === "docked" ? "docked" : "closed");
    expect(oldPolicy(1199)).toBe(railOnly(1199));
    expect(oldPolicy(1200)).toBe(docked(1200));
    expect(oldPolicy(1199) - oldPolicy(1200)).toBe(INSPECTOR_DOCK_WIDTH - 1); // 319px lost
    expect(oldPolicy(1200)).toBeLessThan(oldPolicy(1199)); // the inversion
  });

  it("MUTATION: wiring the stepped left rail would REINTRODUCE an inversion", () => {
    // resolveLeftRailWidth grows from 148 -> 160 -> 184 as width rises, so the
    // canvas loses pixels at each step. This is why that helper stays unwired,
    // and the assertion documents it rather than leaving a mystery.
    const withSteppedRail = (w: number) =>
      usableCanvasWidth({ containerWidth: w, railWidth: resolveLeftRailWidth(w), inspector: "docked" });
    // At 1499 the rail is 160; at 1500 it becomes 184 — a 24px loss for 1px gain.
    expect(resolveLeftRailWidth(1499)).toBe(160);
    expect(resolveLeftRailWidth(1500)).toBe(184);
    expect(withSteppedRail(1500)).toBeLessThan(withSteppedRail(1499));
    // Whereas the constant rail the layout actually uses is monotonic there.
    expect(frame(1500, "docked")).toBeGreaterThan(frame(1499, "docked"));
  });
});

describe("preserveInspectorVisibility", () => {
  it("does not conjure a docked Inspector for a user who had it closed", () => {
    // The transition that caused the 319px cliff.
    const next = preserveInspectorVisibility({
      wasVisible: false,
      nextMode: "docked",
      persistedDock: true,
    });
    expect(next.inspectorDocked).toBe(false);
    expect(next.drawerOpen).toBe(false);
  });

  it("promotes a visible drawer into the dock when the width affords one", () => {
    const next = preserveInspectorVisibility({
      wasVisible: true,
      nextMode: "docked",
      persistedDock: true,
    });
    expect(next.inspectorDocked).toBe(true);
    expect(next.drawerOpen).toBe(false);
  });

  it("demotes a dock into a drawer below the threshold, rather than hiding it", () => {
    const next = preserveInspectorVisibility({
      wasVisible: true,
      nextMode: "overlay",
      persistedDock: true,
    });
    expect(next.drawerOpen).toBe(true);
  });

  it("does NOT destroy the durable dock preference when demoting", () => {
    // Measured regression from the first cut of this fix: clearing the
    // preference on the way down meant 1600 (docked) -> 1024 -> 1600 came back
    // UNdocked, because the promotion reads the preference the demotion had just
    // erased. Below the threshold nothing docks anyway, so the flag must ride
    // through untouched.
    const down = preserveInspectorVisibility({
      wasVisible: true,
      nextMode: "overlay",
      persistedDock: true,
    });
    expect(down.inspectorDocked).toBe(true);
    const backUp = preserveInspectorVisibility({
      wasVisible: down.drawerOpen || down.inspectorDocked,
      nextMode: "docked",
      persistedDock: down.inspectorDocked,
    });
    expect(backUp.inspectorDocked).toBe(true);
  });

  it("keeps a hidden Inspector hidden below the threshold too", () => {
    const next = preserveInspectorVisibility({
      wasVisible: false,
      nextMode: "overlay",
      persistedDock: false,
    });
    expect(next.drawerOpen).toBe(false);
    expect(next.inspectorDocked).toBe(false);
  });

  it("respects a user who has explicitly undocked at a docking width", () => {
    // Visible via drawer, but the durable preference says "not docked": honour
    // the preference rather than silently re-docking on the next resize.
    const next = preserveInspectorVisibility({
      wasVisible: true,
      nextMode: "docked",
      persistedDock: false,
    });
    expect(next.inspectorDocked).toBe(false);
  });

  it("round-trips a resize without changing visibility, in both directions", () => {
    for (const wasVisible of [true, false]) {
      const down = preserveInspectorVisibility({ wasVisible, nextMode: "overlay", persistedDock: true });
      // Visibility in OVERLAY mode is the drawer alone: nothing docks there.
      expect(down.drawerOpen).toBe(wasVisible);
      const up = preserveInspectorVisibility({
        wasVisible: down.drawerOpen,
        nextMode: "docked",
        persistedDock: down.inspectorDocked,
      });
      expect(up.inspectorDocked || up.drawerOpen).toBe(wasVisible);
    }
  });
});

describe("isInspectorVisible", () => {
  it("treats a drawer as visible — it is on screen and over the page", () => {
    expect(isInspectorVisible("drawer")).toBe(true);
    expect(isInspectorVisible("docked")).toBe(true);
    expect(isInspectorVisible("closed")).toBe(false);
  });

  it("agrees with resolvePanelLayout for every combination", () => {
    for (const mode of ["docked", "overlay"] as const) {
      for (const inspectorDocked of [true, false]) {
        for (const drawerOpen of [true, false]) {
          const layout = resolvePanelLayout({ mode, inspectorDocked, drawerOpen });
          const visible = isInspectorVisible(layout.inspector);
          // Visible exactly when something asked for it and the mode allows it.
          const expected = mode === "docked" ? inspectorDocked || drawerOpen : drawerOpen;
          expect(visible).toBe(expected);
        }
      }
    }
  });
});
