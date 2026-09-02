import { describe, expect, it } from "vitest";
import {
  DOCUMENT_INSPECTOR_TABS,
  INSPECTOR_STRIP_WIDTH,
  INSPECTOR_TAB_COST,
  PANEL_BREAKPOINTS,
  drawerAfterResize,
  inspectorTabPresentation,
  isDocumentInspectorTab,
  resolveActiveInspectorTab,
  resolveInspectorTabs,
  resolveLeftRailWidth,
  resolvePanelLayout,
  resolvePanelMode,
  type InspectorTabId,
  type PanelMode,
} from "./editorPanelLayout";

/**
 * These tests pin the SINGLE-dock contract.
 *
 * History worth keeping: the shipped layout docked the document inspector at
 * Tailwind's `2xl` (1536px) while properties docked at `lg`, which measured as
 *
 *   1440px → 696px of canvas
 *   1536px → 504px of canvas
 *
 * Widening the window shrank the canvas. Two docked panels then also cost 640px
 * of permanent right-edge furniture, which is why the dock is now singular. The
 * inversion guard below is kept verbatim in spirit — it is the property that
 * matters, not the panel count that used to satisfy it.
 */
describe("resolvePanelMode", () => {
  it.each([
    [360, "overlay"],
    [768, "overlay"],
    [1024, "overlay"],
    [1199, "overlay"],
    [1200, "docked"],
    [1280, "docked"],
    [1440, "docked"],
    [1536, "docked"],
    [1600, "docked"],
    [1920, "docked"],
  ] as Array<[number, PanelMode]>)("%ipx → %s", (width, expected) => {
    expect(resolvePanelMode(width)).toBe(expected);
  });

  it("uses an inclusive lower bound at the breakpoint", () => {
    expect(resolvePanelMode(PANEL_BREAKPOINTS.docked)).toBe("docked");
    expect(resolvePanelMode(PANEL_BREAKPOINTS.docked - 1)).toBe("overlay");
  });
});

describe("resolvePanelLayout", () => {
  it("docks the single Inspector at or above the breakpoint", () => {
    expect(
      resolvePanelLayout({ mode: "docked", inspectorDocked: true, drawerOpen: false }),
    ).toEqual({ inspector: "docked" });
  });

  it("docks nothing below the breakpoint — the canvas keeps the width", () => {
    expect(
      resolvePanelLayout({ mode: "overlay", inspectorDocked: true, drawerOpen: false }),
    ).toEqual({ inspector: "closed" });
  });

  it("honours a collapsed dock preference", () => {
    expect(
      resolvePanelLayout({ mode: "docked", inspectorDocked: false, drawerOpen: false }),
    ).toEqual({ inspector: "closed" });
  });

  it("opens as a drawer where it cannot dock", () => {
    expect(
      resolvePanelLayout({ mode: "overlay", inspectorDocked: true, drawerOpen: true }).inspector,
    ).toBe("drawer");
  });

  it("lets a collapsed dock still be peeked at as a drawer", () => {
    // The user collapsed the dock for canvas room but wants one look at Comments.
    expect(
      resolvePanelLayout({ mode: "docked", inspectorDocked: false, drawerOpen: true }).inspector,
    ).toBe("drawer");
  });

  it("prefers the dock over a stale drawer flag", () => {
    // Docked wins: two copies of one panel must never both render.
    expect(
      resolvePanelLayout({ mode: "docked", inspectorDocked: true, drawerOpen: true }).inspector,
    ).toBe("docked");
  });

  it("never shrinks the canvas as the viewport grows", () => {
    // THE regression this contract exists to prevent. With one dock the count is
    // 0 or 1 and can only rise with width, so the 1440→1536 inversion is now
    // structurally impossible — but assert it, because the property is the point.
    const dockedAt = (width: number) =>
      resolvePanelLayout({
        mode: resolvePanelMode(width),
        inspectorDocked: true,
        drawerOpen: false,
      }).inspector === "docked"
        ? 1
        : 0;

    expect(dockedAt(1440)).toBe(1);
    expect(dockedAt(1536)).toBe(1); // was 2 under the old rule — the inversion
    expect(dockedAt(1600)).toBe(1); // and never a second panel at any width
    const widths = [360, 768, 1024, 1200, 1280, 1440, 1536, 1600, 1920, 2560];
    const counts = widths.map(dockedAt);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    // At most one docked right panel, at every width.
    expect(Math.max(...counts)).toBe(1);
  });
});

describe("drawerAfterResize", () => {
  it("drops the drawer once the Inspector docks", () => {
    expect(drawerAfterResize(true, { inspector: "docked" })).toBe(false);
  });

  it("keeps a drawer that still has nowhere to dock", () => {
    expect(drawerAfterResize(true, { inspector: "drawer" })).toBe(true);
  });

  it("is a no-op when nothing is open", () => {
    expect(drawerAfterResize(false, { inspector: "docked" })).toBe(false);
    expect(drawerAfterResize(false, { inspector: "closed" })).toBe(false);
  });
});

describe("resolveInspectorTabs", () => {
  it("offers Properties plus the document tabs in a workspace", () => {
    expect(resolveInspectorTabs(true)).toEqual([
      "properties",
      "outline",
      "comments",
      "versions",
    ]);
  });

  it("offers only Properties in the standalone editor", () => {
    // No workspace document → no outline/comments/versions to show. One honest
    // tab beats three that exist only to explain their own emptiness.
    expect(resolveInspectorTabs(false)).toEqual(["properties"]);
  });

  it("puts Properties first — it describes the live selection", () => {
    expect(resolveInspectorTabs(true)[0]).toBe("properties");
  });
});

describe("resolveActiveInspectorTab", () => {
  it("keeps the requested tab when it is available", () => {
    const tabs = resolveInspectorTabs(true);
    expect(resolveActiveInspectorTab("comments", tabs)).toBe("comments");
    expect(resolveActiveInspectorTab("properties", tabs)).toBe("properties");
  });

  it("falls back to Properties when the requested tab vanishes", () => {
    // Closing the workspace document (or mounting standalone with a remembered
    // tab) must not leave the panel rendering a body for a tab that is gone.
    expect(resolveActiveInspectorTab("comments", resolveInspectorTabs(false))).toBe("properties");
    expect(resolveActiveInspectorTab("versions", resolveInspectorTabs(false))).toBe("properties");
  });

  it("always resolves to an available tab", () => {
    const all: InspectorTabId[] = ["properties", "outline", "comments", "versions"];
    for (const hasDoc of [true, false]) {
      const tabs = resolveInspectorTabs(hasDoc);
      for (const requested of all) {
        expect(tabs).toContain(resolveActiveInspectorTab(requested, tabs));
      }
    }
  });
});

describe("isDocumentInspectorTab", () => {
  it("classifies the document-scoped tabs", () => {
    expect(DOCUMENT_INSPECTOR_TABS.every(isDocumentInspectorTab)).toBe(true);
  });

  it("does not classify Properties as document-scoped", () => {
    // Properties describes the SELECTION and is rendered by the editor itself.
    expect(isDocumentInspectorTab("properties")).toBe(false);
  });
});

describe("resolveLeftRailWidth", () => {
  it("steps down as width gets scarce, and never below the legible floor", () => {
    expect(resolveLeftRailWidth(1600)).toBe(184);
    expect(resolveLeftRailWidth(1500)).toBe(184);
    expect(resolveLeftRailWidth(1400)).toBe(160);
    expect(resolveLeftRailWidth(1280)).toBe(160);
    expect(resolveLeftRailWidth(1200)).toBe(148);
  });

  it("stays comfortable below the dock breakpoint (width is not scarce there)", () => {
    expect(resolveLeftRailWidth(1199)).toBe(184);
    expect(resolveLeftRailWidth(768)).toBe(184);
  });

  it("is defensive about nonsense widths during first paint", () => {
    expect(resolveLeftRailWidth(0)).toBe(184);
    expect(resolveLeftRailWidth(-1)).toBe(184);
    expect(resolveLeftRailWidth(Number.NaN)).toBe(184);
  });
});

describe("inspectorTabPresentation", () => {
  /**
   * The measured defect: at a 1600px viewport the four-tab workspace strip showed
   * its labels and truncated them — "Properties" given a 49px box for 55px of
   * text, "Comments" 49px for 58px. The old rule keyed off VIEWPORT width
   * (`max-[1320px]:hidden`), which cannot be right: the dock is a fixed 320px
   * wherever it docks, so only the tab count changes what one tab gets.
   */
  it("gives the standalone editor's single tab both icon and label", () => {
    expect(inspectorTabPresentation(1)).toBe("icon-and-label");
  });

  it("drops the icon — never the word — for the four-tab workspace strip", () => {
    expect(inspectorTabPresentation(4)).toBe("label-only");
  });

  it("keeps icon and label while they still fit", () => {
    expect(inspectorTabPresentation(2)).toBe("icon-and-label");
    expect(inspectorTabPresentation(3)).toBe("icon-and-label");
  });

  it("falls back to icon + tooltip only when even bare labels cannot fit", () => {
    // Unreachable with today's four tabs. Kept so a fifth tab degrades to an
    // honest compact mode instead of silently reintroducing the ellipsis.
    expect(inspectorTabPresentation(5)).toBe("icon-only");
    expect(inspectorTabPresentation(9)).toBe("icon-only");
  });

  it("agrees with its own width budget at every boundary", () => {
    // The point of asserting this arithmetic rather than just the outcomes: if
    // someone widens the dock or the type scale, the constants and the thresholds
    // move together or this fails.
    for (const count of [1, 2, 3, 4, 5, 6, 11, 12]) {
      const chosen = inspectorTabPresentation(count);
      expect(count * INSPECTOR_TAB_COST[chosen]).toBeLessThanOrEqual(
        // `icon-only` is the floor and has no richer fallback, so it is allowed to
        // overflow rather than to have no answer at all.
        chosen === "icon-only" ? Number.POSITIVE_INFINITY : INSPECTOR_STRIP_WIDTH,
      );
      // And it must be the RICHEST presentation that fits, not merely one that does.
      if (chosen === "label-only") {
        expect(count * INSPECTOR_TAB_COST["icon-and-label"]).toBeGreaterThan(INSPECTOR_STRIP_WIDTH);
      }
      if (chosen === "icon-only") {
        expect(count * INSPECTOR_TAB_COST["label-only"]).toBeGreaterThan(INSPECTOR_STRIP_WIDTH);
      }
    }
  });

  it("is defensive about nonsense counts during first paint", () => {
    expect(inspectorTabPresentation(0)).toBe("icon-and-label");
    expect(inspectorTabPresentation(-3)).toBe("icon-and-label");
    expect(inspectorTabPresentation(Number.NaN)).toBe("icon-and-label");
  });

  it("keeps the real four-tab strip inside the real 320px dock", () => {
    // 320px dock − 1px border − 31px collapse button = 288px, and the shipped
    // strip is exactly the four tabs resolveInspectorTabs gives a workspace doc.
    const tabs = resolveInspectorTabs(true);
    expect(tabs).toHaveLength(4);
    expect(tabs.length * INSPECTOR_TAB_COST[inspectorTabPresentation(tabs.length)])
      .toBeLessThanOrEqual(INSPECTOR_STRIP_WIDTH);
  });
});
