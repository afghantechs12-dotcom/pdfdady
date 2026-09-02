import type { Bounds, Point } from "@/src/domain/editor/geometry";
import type { EditorObject } from "@/src/domain/editor/objects";
import { generateId } from "@/src/domain/editor/ids";

/**
 * Secondary extension points (Part 6 infrastructure) — the surfaces future
 * milestones flesh out. Each ships a working default so the editor runs without
 * a plugin: in-memory storage where the behavior is just bookkeeping (guides,
 * components), a real enumeration where the data is static (the 14 PDF standard
 * fonts), and an honest empty result where the logic is genuinely future work
 * (ruler tick generation, smart alignment). Plugins override any of them.
 */

// ---------------------------------------------------------------------------
// Guides — user-placed alignment lines. In-memory default is fully functional.
// ---------------------------------------------------------------------------

/** A guide line: vertical (x = const) or horizontal (y = const). */
export interface Guide {
  id: string;
  orientation: "vertical" | "horizontal";
  /** The fixed coordinate (x for vertical, y for horizontal) in page space. */
  position: number;
}

export interface IGuideEngine {
  list(): Guide[];
  addGuide(guide: Omit<Guide, "id">): Guide;
  removeGuide(id: string): void;
  clear(): void;
}

/** A working in-memory guide store — the default. */
export class InMemoryGuideEngine implements IGuideEngine {
  private readonly guides = new Map<string, Guide>();

  list(): Guide[] {
    return [...this.guides.values()];
  }

  addGuide(guide: Omit<Guide, "id">): Guide {
    const full: Guide = { id: generateId("guide"), ...guide };
    this.guides.set(full.id, full);
    return full;
  }

  removeGuide(id: string): void {
    this.guides.delete(id);
  }

  clear(): void {
    this.guides.clear();
  }
}

// ---------------------------------------------------------------------------
// Rulers — tick generation for the ruler bars. Default returns no ticks.
// ---------------------------------------------------------------------------

export interface RulerTick {
  /** The page-space coordinate of the tick. */
  position: number;
  /** The label to render (may be empty for minor ticks). */
  label: string;
  /** Whether this is a major (labeled) or minor tick. */
  major: boolean;
}

export interface IRulerEngine {
  /** Ticks for a viewport span, for the given orientation. */
  ticksFor(start: number, end: number, orientation: "vertical" | "horizontal"): RulerTick[];
}

/**
 * A no-op ruler engine: returns no ticks. A real implementation chooses a
 * "nice" tick interval from the zoom level and viewport span — that's layout
 * work that arrives with the rulers UI in a future milestone.
 */
export class NoopRulerEngine implements IRulerEngine {
  ticksFor(_start: number, _end: number, _orientation: "vertical" | "horizontal"): RulerTick[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Smart alignment — suggests alignment/distribution operations for a selection.
// Default returns no suggestions.
// ---------------------------------------------------------------------------

export interface AlignmentSuggestion {
  /** Which edge/axis to align to: the target object's left/right/top/bottom/center. */
  target: "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
  /** The page-space coordinate to align to. */
  position: number;
}

export interface IAlignmentEngine {
  /** Alignment suggestions given the selected objects' world bounds. */
  suggestions(selectionBounds: Bounds[]): AlignmentSuggestion[];
}

/**
 * A no-op alignment engine. Real smart alignment (edges, centers, distribution)
 * is future work; the interface lets a plugin supply it without core changes.
 */
export class NoopAlignmentEngine implements IAlignmentEngine {
  suggestions(_selectionBounds: Bounds[]): AlignmentSuggestion[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fonts — enumerate available fonts. Default lists the 14 PDF standard fonts.
// ---------------------------------------------------------------------------

export interface FontDescriptor {
  /** PostScript font name (e.g. "Helvetica-Bold"). */
  family: string;
  /** A display label for menus (e.g. "Helvetica Bold"). */
  label: string;
  /** Whether the font is a PDF built-in (no embedding needed) or requires embedding. */
  standard: boolean;
}

export interface IFontProvider {
  list(): FontDescriptor[];
}

/**
 * Lists the 14 PDF base-14 fonts — always available in any PDF, no embedding
 * required. This is the editor's default font source; a plugin can register a
 * provider that also lists embedded/custom fonts.
 */
export class StandardFontsProvider implements IFontProvider {
  private static readonly FONTS: FontDescriptor[] = (
    [
      ["Helvetica", "Helvetica", true],
      ["Helvetica-Bold", "Helvetica Bold", true],
      ["Helvetica-Oblique", "Helvetica Oblique", true],
      ["Helvetica-BoldOblique", "Helvetica Bold Oblique", true],
      ["Times-Roman", "Times Roman", true],
      ["Times-Bold", "Times Bold", true],
      ["Times-Italic", "Times Italic", true],
      ["Times-BoldItalic", "Times Bold Italic", true],
      ["Courier", "Courier", true],
      ["Courier-Bold", "Courier Bold", true],
      ["Courier-Oblique", "Courier Oblique", true],
      ["Courier-BoldOblique", "Courier Bold Oblique", true],
      ["Symbol", "Symbol", true],
      ["ZapfDingbats", "Zapf Dingbats", true],
    ] as Array<[string, string, boolean]>
  ).map(([family, label, standard]) => ({ family, label, standard }));

  list(): FontDescriptor[] {
    return [...StandardFontsProvider.FONTS];
  }
}

// ---------------------------------------------------------------------------
// Reusable components — a library of pre-built object groups. In-memory default.
// ---------------------------------------------------------------------------

export interface ComponentDescriptor {
  id: string;
  name: string;
  /** Factory that produces the objects for one instance, placed at `origin`. */
  instantiate: (origin: Point) => EditorObject[];
}

export interface IComponentLibrary {
  list(): ComponentDescriptor[];
  register(component: ComponentDescriptor): void;
  unregister(id: string): boolean;
  instantiate(id: string, origin: Point): EditorObject[];
}

/** A working in-memory component library — the default. */
export class InMemoryComponentLibrary implements IComponentLibrary {
  private readonly components = new Map<string, ComponentDescriptor>();

  list(): ComponentDescriptor[] {
    return [...this.components.values()];
  }

  register(component: ComponentDescriptor): void {
    if (!component.id) throw new Error("ComponentDescriptor requires a non-empty id.");
    this.components.set(component.id, component);
  }

  unregister(id: string): boolean {
    return this.components.delete(id);
  }

  instantiate(id: string, origin: Point): EditorObject[] {
    const component = this.components.get(id);
    if (!component) throw new Error(`Component "${id}" is not registered.`);
    return component.instantiate(origin);
  }
}
