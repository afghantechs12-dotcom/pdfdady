import type { Command } from "../commands/types";
import type { EditorState } from "@/src/domain/editor/document";
import type { ObjectTypeDefinition } from "../registry";
import type { SnapStrategy } from "../extensions/Snapping";
import type { ComponentDescriptor } from "../extensions/Extensions";

/**
 * The plugin extension surface. During `activate`, a plugin receives an
 * {@link EditorPluginApi} and registers its contributions (object types, tools,
 * commands, snap strategies, panels, components) or replaces an engine (guides,
 * rulers, alignment, fonts). The registry owns the resulting state; the plugin
 * owns its own cleanup (it returns a deactivate function from `activate`).
 *
 * This is the ONLY mechanism by which the editor gains new object kinds, tools,
 * or engines — the core never imports a plugin, so plugins can be added or
 * removed without touching core code.
 */

/** A toolbar tool entry. Interaction logic arrives with the tool controller (future). */
export interface ToolDefinition {
  id: string;
  name: string;
  icon?: string;
  shortcut?: string;
}

/** A named, undoable command factory bound to a keyboard shortcut / menu item. */
export interface CommandDefinition {
  id: string;
  label: string;
  shortcut?: string;
  /** Produces the command to run (the editor executes it through the history). */
  make: (state: EditorState) => Command;
}

/** A UI panel slot (layers, properties, etc.). Rendering arrives with the UI. */
export interface PanelDefinition {
  id: string;
  title: string;
  position: "left" | "right" | "bottom";
}

/** The extension API handed to a plugin's `activate`. */
export interface EditorPluginApi {
  registerObjectType(def: ObjectTypeDefinition): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(command: CommandDefinition): void;
  registerSnapStrategy(strategy: SnapStrategy): void;
  registerPanel(panel: PanelDefinition): void;
  registerComponent(component: ComponentDescriptor): void;
  /** Replace a default engine with a plugin-supplied one. */
  setGuideEngine(engine: import("../extensions/Extensions").IGuideEngine): void;
  setRulerEngine(engine: import("../extensions/Extensions").IRulerEngine): void;
  setAlignmentEngine(engine: import("../extensions/Extensions").IAlignmentEngine): void;
  setFontProvider(provider: import("../extensions/Extensions").IFontProvider): void;
}

/**
 * A plugin. `activate` receives the API and may return a deactivate function
 * (called on `deactivate`); the plugin is responsible for unregistering anything
 * it added, which keeps the registry free of per-plugin bookkeeping.
 */
export interface EditorPlugin {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  activate(api: EditorPluginApi): void | (() => void);
}
