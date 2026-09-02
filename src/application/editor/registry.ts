import type {
  EditorObject,
  EditorObjectKind,
  ReconstructedBase,
} from "@/src/domain/editor/objects";

/**
 * Registry for editor object types. The built-in kinds (text, image, shape, …)
 * are handled directly by the serializer; this registry is how plugins teach the
 * editor about NEW kinds — their serialize/deserialize/default-factory so a
 * plugin object survives save/load and can be created from a toolbar.
 *
 * A plugin registers its type once (on activation) and the editor core thereafter
 * stores, selects, transforms, layers, and serializes instances of that kind
 * without knowing anything about its payload.
 */
export interface ObjectTypeDefinition {
  /** The plugin-defined kind string (not one of the built-in EditorObjectKind). */
  kind: string;
  /** Human-readable name for menus/tooltips. */
  displayName: string;
  /** Serializes the kind-specific payload (`data`) to a JSON-safe value. */
  serialize?: (obj: EditorObject) => unknown;
  /** Reconstructs an object from its base fields + serialized payload. */
  deserialize?: (base: ReconstructedBase, data: unknown) => EditorObject;
  /** Creates a default object of this kind at a given id + layer. */
  create?: (params: { id: string; layerId: string }) => EditorObject;
}

/**
 * A minimal, type-safe registry. Registering a duplicate kind overwrites the
 * previous definition (last-wins) so a plugin can be reloaded; production code
 * should register each kind exactly once at activation.
 */
export class ObjectTypeRegistry {
  private readonly defs = new Map<string, ObjectTypeDefinition>();

  register(def: ObjectTypeDefinition): void {
    if (!def.kind) throw new Error("ObjectTypeDefinition requires a non-empty kind.");
    this.defs.set(def.kind, def);
  }

  /** Removes a kind's definition (used by the plugin registry on deactivate). */
  unregister(kind: string): boolean {
    return this.defs.delete(kind);
  }

  get(kind: string): ObjectTypeDefinition | undefined {
    return this.defs.get(kind);
  }

  has(kind: string): boolean {
    return this.defs.has(kind);
  }

  all(): ObjectTypeDefinition[] {
    return [...this.defs.values()];
  }

  /** The set of registered kinds (useful for validating serialized data). */
  kinds(): string[] {
    return [...this.defs.keys()];
  }
}

/** The built-in kind names, for fast membership checks in the serializer. */
export const BUILTIN_OBJECT_KINDS: ReadonlySet<EditorObjectKind> = new Set([
  "text",
  "image",
  "shape",
  "annotation",
  "signature",
  "highlight",
  "drawing",
]);
