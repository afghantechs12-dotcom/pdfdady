import type { EditorState } from "@/src/domain/editor/document";

/**
 * Port: serialize/deserialize editor state to a versioned, JSON-safe format.
 *
 * The format is `{ format: "pdfdadi-editor", version, … }`. Deserialization
 * validates the shape (zod), runs any registered migrations to bring an older
 * `version` up to {@link EDITOR_FORMAT_VERSION}, and returns live state. The
 * round-trip `deserialize(serialize(state))` is identity for all stable fields.
 *
 * Plugin-registered object kinds (kinds outside the built-in union) are
 * (de)serialized through the object-type registry so a plugin's payload survives
 * a save/load cycle without the core knowing its shape.
 */
export interface ISerializer {
  serialize(state: EditorState): SerializedEditorState;
  deserialize(data: unknown): EditorState;
}

/** The top-level serialized envelope. */
export interface SerializedEditorState {
  format: "pdfdadi-editor";
  version: number;
  document: unknown;
  activePageId: string;
  selection: unknown;
}
