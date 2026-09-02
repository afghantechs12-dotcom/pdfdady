import { describe, expect, it } from "vitest";
import {
  clampMenuPosition,
  resolveContextMenu,
  type ContextMenuContext,
} from "./contextMenuLogic";
import { makeImage } from "@/src/domain/editor/testFactories";

const ctx = (over: Partial<ContextMenuContext> = {}): ContextMenuContext => ({
  selectionCount: 0,
  selectedKinds: [],
  anyLocked: false,
  anyVisible: true,
  anyGrouped: false,
  ...over,
});

const byId = (items: ReturnType<typeof resolveContextMenu>, id: string) =>
  items.find((i) => i.id === id);

describe("resolveContextMenu (M6.15)", () => {
  it("empty selection: only Paste is enabled; crop is not rendered at all", () => {
    const items = resolveContextMenu(ctx());
    expect(byId(items, "paste")?.enabled).toBe(true);
    for (const id of ["cut", "copy", "duplicate", "delete", "bringForward", "sendBackward", "bringToFront", "sendToBack", "lock", "hide", "group", "ungroup"]) {
      expect(byId(items, id)?.enabled, id).toBe(false);
    }
    expect(byId(items, "cropImage")).toBeUndefined();
  });

  it("single unlocked object: clipboard, z-order, lock/hide enabled; group needs 2", () => {
    const items = resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"] }));
    for (const id of ["cut", "copy", "duplicate", "delete", "bringForward", "sendToBack", "lock", "hide"]) {
      expect(byId(items, id)?.enabled, id).toBe(true);
    }
    expect(byId(items, "group")?.enabled).toBe(false);
    expect(byId(items, "ungroup")?.enabled).toBe(false);
  });

  it("locked selection: destructive actions blocked, copy/lock stay usable", () => {
    const items = resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"], anyLocked: true }));
    expect(byId(items, "cut")?.enabled).toBe(false);
    expect(byId(items, "delete")?.enabled).toBe(false);
    expect(byId(items, "copy")?.enabled).toBe(true);
    expect(byId(items, "lock")?.enabled).toBe(true);
    expect(byId(items, "lock")?.label).toBe("Unlock");
  });

  it("group needs ≥2 objects; ungroup needs a grouped object", () => {
    expect(byId(resolveContextMenu(ctx({ selectionCount: 2, selectedKinds: ["text", "shape"] })), "group")?.enabled).toBe(true);
    expect(byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"], anyGrouped: true })), "ungroup")?.enabled).toBe(true);
  });

  it("hide/show label follows current visibility", () => {
    expect(byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"], anyVisible: true })), "hide")?.label).toBe("Hide");
    expect(byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"], anyVisible: false })), "hide")?.label).toBe("Show");
  });

  it("Crop Image renders only for exactly one selected image", () => {
    expect(byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["image"] })), "cropImage")?.enabled).toBe(true);
    expect(byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["text"] })), "cropImage")).toBeUndefined();
    expect(byId(resolveContextMenu(ctx({ selectionCount: 2, selectedKinds: ["image", "image"] })), "cropImage")).toBeUndefined();
  });

  it("Crop Image is disabled (not hidden) for a locked image", () => {
    const item = byId(resolveContextMenu(ctx({ selectionCount: 1, selectedKinds: ["image"], anyLocked: true })), "cropImage");
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(false);
  });

  it("uses canonical eligibility when full selected objects are supplied", () => {
    const singular = makeImage({ transform: { a: 1, b: 0, c: 1, d: 0, e: 0, f: 0 } });
    const item = byId(resolveContextMenu(ctx({
      selectionCount: 1,
      selectedKinds: ["image"],
      selectedObjects: [singular],
    })), "cropImage");
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(false);
  });
});

describe("clampMenuPosition (M6.15 edge collision)", () => {
  const menu = { width: 180, height: 300 };
  const view = { width: 1000, height: 600 };

  it("keeps a fitting position unchanged", () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, menu, view)).toEqual({ x: 100, y: 100 });
  });

  it("clamps off the right and bottom edges", () => {
    const p = clampMenuPosition({ x: 950, y: 550 }, menu, view);
    expect(p.x + menu.width).toBeLessThanOrEqual(view.width);
    expect(p.y + menu.height).toBeLessThanOrEqual(view.height);
  });

  it("clamps negative positions to the margin", () => {
    expect(clampMenuPosition({ x: -20, y: -20 }, menu, view)).toEqual({ x: 4, y: 4 });
  });
});
