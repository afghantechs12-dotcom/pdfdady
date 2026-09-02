import { CommandHistory } from "@/src/application/editor/commands/CommandHistory";
import { createEditorDocumentService, type EditorDocumentService } from "@/src/application/editor/EditorDocumentService";
import { LayerService } from "@/src/application/editor/layers/LayerService";
import { PluginRegistry } from "@/src/application/editor/plugins/PluginRegistry";
import { SerializationService } from "@/src/application/editor/serialization/SerializationService";
import { SelectionService } from "@/src/application/editor/selection/SelectionService";
import type { EditorState } from "@/src/domain/editor/document";

/**
 * Constructs a fresh, independent {@link EditorDocumentService} for **client-side**
 * use (the visual editor runs entirely in the browser).
 *
 * The production DI container (`src/application/di/container.ts`) wires the same
 * services for any server-side editor use, but importing it into a client
 * component would pull server-only infra (Prisma, R2 SDK, ioredis) into the
 * browser bundle. The editor services themselves are isomorphic pure logic, so
 * this factory builds the exact same dependency set the DI factory does —
 * without the server baggage — keeping the editor client-safe while preserving
 * the M3.e architecture (facade + history + services + plugin registry).
 *
 * Each call produces its own `CommandHistory` + state, so every editor surface
 * gets an independent undo stack (mirrors `EditorServiceFactory.create()`).
 */
export function createEditorInstance(initialState?: EditorState): EditorDocumentService {
  const plugins = new PluginRegistry();
  return createEditorDocumentService({
    history: new CommandHistory(),
    selection: new SelectionService(),
    layers: new LayerService(),
    serializer: new SerializationService(plugins.objectTypesRegistry),
    plugins,
    initialState,
  });
}
