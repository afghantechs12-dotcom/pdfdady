import { beforeEach, describe, expect, it } from "vitest";
import { makeRect } from "@/src/domain/editor/testFactories";
import { GridSnapStrategy } from "../extensions/Snapping";
import type { IFontProvider } from "../extensions/Extensions";
import type { EditorPlugin } from "./types";
import { PluginRegistry } from "./PluginRegistry";

describe("PluginRegistry: defaults (no plugins)", () => {
  it("ships working defaults for every engine + empty registries", () => {
    const registry = new PluginRegistry();
    expect(registry.getTools()).toEqual([]);
    expect(registry.getCommands()).toEqual([]);
    expect(registry.getPanels()).toEqual([]);
    expect(registry.getSnapStrategies()).toEqual([]);
    // No-op snap engine when no strategies are registered.
    expect(registry.snapEngine.snap({ pointer: { x: 5, y: 5 }, draggedIds: [], threshold: 5, zoom: 1 }).active).toBe(false);
    // Standard fonts default.
    expect(registry.fontProvider.list()).toHaveLength(14);
    // In-memory guide engine is functional.
    expect(registry.guidesEngine.list()).toEqual([]);
  });
});

describe("PluginRegistry: activation + contributions", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it("a plugin's contributions appear through the accessors after activate", () => {
    const plugin: EditorPlugin = {
      id: "shapes",
      name: "Shapes",
      activate: (api) => {
        api.registerTool({ id: "rect-tool", name: "Rectangle", shortcut: "R" });
        api.registerCommand({ id: "add-rect", label: "Add Rectangle", make: () => ({ type: "noop", label: "x", apply: (s) => s, invert: (s) => s }) });
        api.registerPanel({ id: "layers", title: "Layers", position: "right" });
        api.registerSnapStrategy(new GridSnapStrategy(10));
        api.registerComponent({
          id: "preset-rect",
          name: "Preset Rect",
          instantiate: (o) => [makeRect({ transform: { a: 1, b: 0, c: 0, d: 1, e: o.x, f: o.y } })],
        });
        api.registerObjectType({ kind: "stamp", displayName: "Stamp" });
      },
    };
    registry.register(plugin);
    registry.activate("shapes");

    expect(registry.isActive("shapes")).toBe(true);
    expect(registry.getTools().map((t) => t.id)).toEqual(["rect-tool"]);
    expect(registry.getCommand("add-rect")?.label).toBe("Add Rectangle");
    expect(registry.getPanels()).toHaveLength(1);
    expect(registry.getSnapStrategies()).toHaveLength(1);
    expect(registry.getComponents().list().map((c) => c.id)).toEqual(["preset-rect"]);
    expect(registry.objectTypesRegistry.get("stamp")?.displayName).toBe("Stamp");
    // The grid strategy makes the snap engine snap.
    const snap = registry.snapEngine.snap({ pointer: { x: 23, y: 23 }, draggedIds: [], threshold: 5, zoom: 1 });
    expect(snap.active).toBe(true);
  });

  it("replaces engines via the api", () => {
    const customFonts: IFontProvider = { list: () => [{ family: "Custom", label: "Custom", standard: false }] };
    const plugin: EditorPlugin = {
      id: "fonts",
      name: "Custom Fonts",
      activate: (api) => api.setFontProvider(customFonts),
    };
    registry.register(plugin);
    registry.activate("fonts");
    expect(registry.fontProvider.list()).toEqual([{ family: "Custom", label: "Custom", standard: false }]);
  });

  it("activate is idempotent", () => {
    let calls = 0;
    const plugin: EditorPlugin = { id: "p", name: "P", activate: (api) => { calls++; api.registerTool({ id: "t", name: "T" }); } };
    registry.register(plugin);
    registry.activate("p");
    registry.activate("p");
    expect(calls).toBe(1);
    expect(registry.getTools()).toHaveLength(1);
  });

  it("activateAll / deactivateAll", () => {
    registry.register({ id: "a", name: "A", activate: (api) => api.registerTool({ id: "ta", name: "TA" }) });
    registry.register({ id: "b", name: "B", activate: (api) => api.registerTool({ id: "tb", name: "TB" }) });
    registry.activateAll();
    expect(registry.getTools().map((t) => t.id).sort()).toEqual(["ta", "tb"]);
    registry.deactivateAll();
    expect(registry.getTools()).toEqual([]);
    expect(registry.isActive("a")).toBe(false);
  });
});

describe("PluginRegistry: deactivate cleans up", () => {
  it("removes a plugin's contributions and restores replaced engines", () => {
    const registry = new PluginRegistry();
    let cleanedUp = false;
    const plugin: EditorPlugin = {
      id: "p",
      name: "P",
      activate: (api) => {
        api.registerTool({ id: "t", name: "T" });
        api.setFontProvider({ list: () => [] });
        return () => {
          cleanedUp = true;
        };
      },
    };
    registry.register(plugin);
    registry.activate("p");
    expect(registry.getTools()).toHaveLength(1);
    registry.deactivate("p");
    // Contributions removed, engine restored to default, cleanup fn ran.
    expect(registry.getTools()).toEqual([]);
    expect(registry.fontProvider.list()).toHaveLength(14); // StandardFonts default
    expect(cleanedUp).toBe(true);
    expect(registry.isActive("p")).toBe(false);
  });

  it("deactivating one plugin leaves another's contributions intact", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "a", name: "A", activate: (api) => api.registerTool({ id: "ta", name: "TA" }) });
    registry.register({ id: "b", name: "B", activate: (api) => api.registerTool({ id: "tb", name: "TB" }) });
    registry.activateAll();
    registry.deactivate("a");
    expect(registry.getTools().map((t) => t.id)).toEqual(["tb"]);
  });

  it("register rejects an empty id", () => {
    const registry = new PluginRegistry();
    expect(() => registry.register({ id: "", name: "x", activate: () => {} })).toThrow();
  });
});
