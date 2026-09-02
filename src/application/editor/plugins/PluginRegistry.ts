import { ObjectTypeRegistry, type ObjectTypeDefinition } from "../registry";
import {
  CompositeSnapEngine,
  type ISnapEngine,
  type SnapStrategy,
} from "../extensions/Snapping";
import {
  InMemoryComponentLibrary,
  InMemoryGuideEngine,
  NoopAlignmentEngine,
  NoopRulerEngine,
  StandardFontsProvider,
  type ComponentDescriptor,
  type IAlignmentEngine,
  type IComponentLibrary,
  type IFontProvider,
  type IGuideEngine,
  type IRulerEngine,
} from "../extensions/Extensions";
import type {
  CommandDefinition,
  EditorPlugin,
  EditorPluginApi,
  PanelDefinition,
  ToolDefinition,
} from "./types";

/**
 * Owns every extension registry + engine and manages plugin lifecycle.
 *
 * Defaults are wired up front so the editor is fully functional with NO plugins:
 * an empty object-type registry, no tools/commands/panels, no snap strategies,
 * and the in-memory/no-op/standard engines. A plugin's `activate` receives an
 * {@link EditorPluginApi} that adds to or replaces those defaults.
 *
 * Teardown is automatic: the registry tags every contribution with the plugin
 * that made it and removes them all on `deactivate`, restoring any replaced
 * engine to its default. A plugin may ALSO return a cleanup function from
 * `activate` for side effects the registry can't reverse (event listeners,
 * timers) — that runs in addition to the automatic contribution removal.
 */
interface PluginContributions {
  toolIds: string[];
  commandIds: string[];
  panelIds: string[];
  snap: SnapStrategy[];
  objectKinds: string[];
  componentIds: string[];
  replacedGuides: boolean;
  replacedRulers: boolean;
  replacedAlignment: boolean;
  replacedFonts: boolean;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, EditorPlugin>();
  private readonly cleanups = new Map<string, () => void>();
  private readonly active = new Set<string>();
  private readonly contributions = new Map<string, PluginContributions>();

  private readonly tools = new Map<string, ToolDefinition>();
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly panels = new Map<string, PanelDefinition>();
  private snapStrategies: SnapStrategy[] = [];

  private readonly objectTypes = new ObjectTypeRegistry();
  private readonly components: IComponentLibrary = new InMemoryComponentLibrary();
  // Default engine instances — restored when the plugin that replaced them deactivates.
  private readonly defaultGuides = new InMemoryGuideEngine();
  private readonly defaultRulers = new NoopRulerEngine();
  private readonly defaultAlignment = new NoopAlignmentEngine();
  private readonly defaultFonts = new StandardFontsProvider();
  private guides: IGuideEngine = this.defaultGuides;
  private rulers: IRulerEngine = this.defaultRulers;
  private alignment: IAlignmentEngine = this.defaultAlignment;
  private fonts: IFontProvider = this.defaultFonts;

  /** Registers a plugin without activating it. */
  register(plugin: EditorPlugin): void {
    if (!plugin.id) throw new Error("EditorPlugin requires a non-empty id.");
    this.plugins.set(plugin.id, plugin);
  }

  /** Activates a registered plugin, capturing its deactivate function. */
  activate(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" is not registered.`);
    if (this.active.has(pluginId)) return; // idempotent
    this.contributions.set(pluginId, {
      toolIds: [],
      commandIds: [],
      panelIds: [],
      snap: [],
      objectKinds: [],
      componentIds: [],
      replacedGuides: false,
      replacedRulers: false,
      replacedAlignment: false,
      replacedFonts: false,
    });
    const api = this.createApi(pluginId);
    const cleanup = plugin.activate(api);
    if (cleanup) this.cleanups.set(pluginId, cleanup);
    this.active.add(pluginId);
  }

  /** Deactivates an active plugin: runs its cleanup and removes its contributions. */
  deactivate(pluginId: string): void {
    if (!this.active.has(pluginId)) return;
    const cleanup = this.cleanups.get(pluginId);
    if (cleanup) {
      cleanup();
      this.cleanups.delete(pluginId);
    }
    this.removeContributions(pluginId);
    this.active.delete(pluginId);
  }

  /** Activates every registered plugin in registration order. */
  activateAll(): void {
    for (const id of this.plugins.keys()) this.activate(id);
  }

  /** Deactivates every active plugin. */
  deactivateAll(): void {
    for (const id of [...this.active]) this.deactivate(id);
  }

  /** True when `pluginId` is registered. */
  isRegistered(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /** True when `pluginId` is currently active. */
  isActive(pluginId: string): boolean {
    return this.active.has(pluginId);
  }

  // --- Registry accessors (the editor reads contributions through these) -----

  get objectTypesRegistry(): ObjectTypeRegistry {
    return this.objectTypes;
  }

  getTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  getCommand(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  getCommands(): CommandDefinition[] {
    return [...this.commands.values()];
  }

  getPanels(): PanelDefinition[] {
    return [...this.panels.values()];
  }

  getSnapStrategies(): SnapStrategy[] {
    return [...this.snapStrategies];
  }

  getComponents(): IComponentLibrary {
    return this.components;
  }

  get guidesEngine(): IGuideEngine {
    return this.guides;
  }

  get rulersEngine(): IRulerEngine {
    return this.rulers;
  }

  get alignmentEngine(): IAlignmentEngine {
    return this.alignment;
  }

  get fontProvider(): IFontProvider {
    return this.fonts;
  }

  /** A composite snap engine over the registered strategies (no-op when empty). */
  get snapEngine(): ISnapEngine {
    return new CompositeSnapEngine(this.snapStrategies);
  }

  // --- Lifecycle helpers ----------------------------------------------------

  private removeContributions(pluginId: string): void {
    const contrib = this.contributions.get(pluginId);
    if (!contrib) return;
    for (const id of contrib.toolIds) this.tools.delete(id);
    for (const id of contrib.commandIds) this.commands.delete(id);
    for (const id of contrib.panelIds) this.panels.delete(id);
    for (const kind of contrib.objectKinds) this.objectTypes.unregister(kind);
    for (const id of contrib.componentIds) this.components.unregister(id);
    if (contrib.snap.length > 0) {
      this.snapStrategies = this.snapStrategies.filter((s) => !contrib.snap.includes(s));
    }
    if (contrib.replacedGuides) this.guides = this.defaultGuides;
    if (contrib.replacedRulers) this.rulers = this.defaultRulers;
    if (contrib.replacedAlignment) this.alignment = this.defaultAlignment;
    if (contrib.replacedFonts) this.fonts = this.defaultFonts;
    this.contributions.delete(pluginId);
  }

  private createApi(pluginId: string): EditorPluginApi {
    const contrib = this.contributions.get(pluginId)!;
    return {
      registerObjectType: (def: ObjectTypeDefinition) => {
        this.objectTypes.register(def);
        contrib.objectKinds.push(def.kind);
      },
      registerTool: (tool: ToolDefinition) => {
        if (!tool.id) throw new Error("ToolDefinition requires a non-empty id.");
        this.tools.set(tool.id, tool);
        contrib.toolIds.push(tool.id);
      },
      registerCommand: (command: CommandDefinition) => {
        if (!command.id) throw new Error("CommandDefinition requires a non-empty id.");
        this.commands.set(command.id, command);
        contrib.commandIds.push(command.id);
      },
      registerSnapStrategy: (strategy: SnapStrategy) => {
        this.snapStrategies.push(strategy);
        contrib.snap.push(strategy);
      },
      registerPanel: (panel: PanelDefinition) => {
        if (!panel.id) throw new Error("PanelDefinition requires a non-empty id.");
        this.panels.set(panel.id, panel);
        contrib.panelIds.push(panel.id);
      },
      registerComponent: (component: ComponentDescriptor) => {
        this.components.register(component);
        contrib.componentIds.push(component.id);
      },
      setGuideEngine: (engine: IGuideEngine) => {
        this.guides = engine;
        contrib.replacedGuides = true;
      },
      setRulerEngine: (engine: IRulerEngine) => {
        this.rulers = engine;
        contrib.replacedRulers = true;
      },
      setAlignmentEngine: (engine: IAlignmentEngine) => {
        this.alignment = engine;
        contrib.replacedAlignment = true;
      },
      setFontProvider: (provider: IFontProvider) => {
        this.fonts = provider;
        contrib.replacedFonts = true;
      },
    };
  }
}
