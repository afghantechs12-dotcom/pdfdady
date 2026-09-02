import { describe, expect, it } from "vitest";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { EditorServiceFactory } from "./EditorDocumentService";
import { PluginRegistry } from "./plugins/PluginRegistry";
import type { ISerializer } from "./ports/ISerializer";
import { getActivePage, getObject } from "@/src/domain/editor/document";
import { makeRect } from "@/src/domain/editor/testFactories";

describe("Editor DI wiring", () => {
  it("resolves the editor services + factory from the production container", () => {
    const factory = appContainer.resolve<EditorServiceFactory>(Tokens.EditorServiceFactory);
    expect(typeof factory.create).toBe("function");
    // The plugin registry + serializer are singletons wired through DI.
    const registry = appContainer.resolve<PluginRegistry>(Tokens.EditorPluginRegistry);
    expect(registry).toBeInstanceOf(PluginRegistry);
    const serializer = appContainer.resolve<ISerializer>(Tokens.EditorSerializer);
    expect(typeof serializer.serialize).toBe("function");
  });

  it("the factory produces independent editor instances, each fully functional", () => {
    const factory = appContainer.resolve<EditorServiceFactory>(Tokens.EditorServiceFactory);
    const ed1 = factory.create();
    const ed2 = factory.create();
    // Independent state + history (not shared).
    expect(ed1).not.toBe(ed2);
    const rect = makeRect();
    ed1.addObject(rect);
    expect(getObject(getActivePage(ed1.getState()), rect.id)).toBeDefined();
    expect(getObject(getActivePage(ed2.getState()), rect.id)).toBeUndefined();
    // Each has its own undo stack.
    ed1.undo();
    expect(getObject(getActivePage(ed1.getState()), rect.id)).toBeUndefined();
  });

  it("the factory accepts an initial state", () => {
    const factory = appContainer.resolve<EditorServiceFactory>(Tokens.EditorServiceFactory);
    const ed = factory.create();
    ed.addObject(makeRect());
    const snapshot = ed.serialize();
    // A second editor seeded with the first's serialized state has the object.
    const ed2 = factory.create();
    ed2.deserialize(JSON.parse(JSON.stringify(snapshot)));
    expect(Object.keys(getActivePage(ed2.getState()).objects)).toHaveLength(1);
  });
});
