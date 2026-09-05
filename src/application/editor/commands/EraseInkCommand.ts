import type { EditorPage, EditorState } from "@/src/domain/editor/document";
import type { DrawingObject } from "@/src/domain/editor/objects";
import type { Command } from "./types";

/** One immutable page patch: exact geometry, layer order and undo/redo. */
export class EraseInkCommand implements Command {
  readonly type = "ink.erase";
  readonly label = "Erase ink";
  private readonly after: EditorPage;
  constructor(private readonly before: EditorPage, replacements: ReadonlyMap<string, DrawingObject[]>) {
    const objects = { ...before.objects };
    for (const [id, fragments] of replacements) {
      delete objects[id];
      for (const f of fragments) objects[f.id] = f;
    }
    this.after = { ...before, objects, layerStack: { ...before.layerStack,
      layers: before.layerStack.layers.map(l => ({ ...l, objectIds: l.objectIds.flatMap(id => replacements.get(id)?.map(f => f.id) ?? [id]) })),
    } };
  }
  private swap(state: EditorState, page: EditorPage): EditorState {
    return { ...state, document: { ...state.document, pages: state.document.pages.map(p => p.id === page.id ? page : p) } };
  }
  apply(state: EditorState) { return this.swap(state, this.after); }
  invert(state: EditorState) { return this.swap(state, this.before); }
}
