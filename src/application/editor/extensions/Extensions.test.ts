import { describe, expect, it } from "vitest";
import { makeRect } from "@/src/domain/editor/testFactories";
import {
  InMemoryComponentLibrary,
  InMemoryGuideEngine,
  NoopAlignmentEngine,
  NoopRulerEngine,
  StandardFontsProvider,
  type ComponentDescriptor,
} from "./Extensions";

describe("Extensions: guides", () => {
  it("adds, lists, removes, and clears guides", () => {
    const engine = new InMemoryGuideEngine();
    const g1 = engine.addGuide({ orientation: "vertical", position: 100 });
    engine.addGuide({ orientation: "horizontal", position: 50 });
    expect(engine.list()).toHaveLength(2);
    expect(g1.id).toBeTruthy();

    engine.removeGuide(g1.id);
    expect(engine.list()).toHaveLength(1);
    engine.clear();
    expect(engine.list()).toHaveLength(0);
  });
});

describe("Extensions: rulers + alignment no-ops", () => {
  it("NoopRulerEngine returns no ticks", () => {
    expect(new NoopRulerEngine().ticksFor(0, 100, "horizontal")).toEqual([]);
  });

  it("NoopAlignmentEngine returns no suggestions", () => {
    expect(new NoopAlignmentEngine().suggestions([{ x: 0, y: 0, width: 10, height: 10 }])).toEqual([]);
  });
});

describe("Extensions: fonts", () => {
  it("StandardFontsProvider lists the 14 PDF base fonts, all standard", () => {
    const fonts = new StandardFontsProvider().list();
    expect(fonts).toHaveLength(14);
    expect(fonts.every((f) => f.standard)).toBe(true);
    expect(fonts.map((f) => f.family)).toContain("Helvetica-Bold");
  });

  it("returns a fresh copy each call (callers can't mutate the source)", () => {
    const provider = new StandardFontsProvider();
    const a = provider.list();
    a.pop();
    expect(provider.list()).toHaveLength(14);
  });
});

describe("Extensions: component library", () => {
  it("registers, lists, and instantiates components", () => {
    const lib = new InMemoryComponentLibrary();
    const stamp: ComponentDescriptor = {
      id: "red-rect",
      name: "Red Rectangle",
      instantiate: (origin) => [makeRect({ transform: { a: 1, b: 0, c: 0, d: 1, e: origin.x, f: origin.y } })],
    };
    lib.register(stamp);
    expect(lib.list().map((c) => c.id)).toEqual(["red-rect"]);

    const objs = lib.instantiate("red-rect", { x: 30, y: 40 });
    expect(objs).toHaveLength(1);
    expect(objs[0].transform.e).toBe(30);
  });

  it("rejects an empty id and throws for an unknown component", () => {
    const lib = new InMemoryComponentLibrary();
    expect(() => lib.register({ id: "", name: "x", instantiate: () => [] })).toThrow();
    expect(() => lib.instantiate("missing", { x: 0, y: 0 })).toThrow();
  });
});
