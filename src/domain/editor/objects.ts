import type { AffineTransform, Bounds, Point } from "./geometry";
import type { TextContent, TextFrame } from "./textContent";
import type { ImportedTextEditMode } from "./sourceText";

/**
 * The object model for the PDFDadi editor foundation.
 *
 * An editor document is a tree of {@link EditorObject}s placed on layers across
 * pages. Every object carries an {@link AffineTransform} that maps its local
 * coordinate space (where {@link localBounds} lives, origin at the object's own
 * top-left) into page space. Editing operations mutate transforms and
 * properties; the local geometry stays stable, which keeps resize/rotate
 * composable and undo/redo tractable.
 *
 * The built-in kinds cover the interactive tools PDFDadi already has (text,
 * image, shape, annotation, signature, highlight, freehand drawing) so the
 * existing tools can eventually be re-expressed as object operations without a
 * model rewrite. New kinds are added by plugins through the object-type
 * registry (see the application layer) — this file only owns the core union.
 */

/** The built-in object kinds. Plugins may register additional kinds. */
export type EditorObjectKind =
  | "text"
  | "image"
  | "shape"
  | "annotation"
  | "signature"
  | "highlight"
  | "drawing";

/**
 * Shape subtypes supported by the built-in `shape` kind (M6 shape library).
 * Every kind's geometry is produced by the canonical pure module
 * `shapeGeometry.ts` — the renderer and the PDF exporter both consume that
 * single path source, so screen and export agree by construction.
 */
export type ShapeKind =
  | "rect"
  | "roundedRect"
  | "ellipse"
  | "circle"
  | "triangle"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "speechBubble"
  | "connector"
  | "bezier"
  | "path";

/** Arrowhead styles for the arrow shape. */
export type ArrowHeadType = "triangle" | "open";

/** Routing styles for the connector shape. */
export type ConnectorKind = "straight" | "elbow";

/** Brush types for the freehand drawing tool (M6 drawing upgrade). */
export type BrushKind = "pen" | "marker" | "highlighter" | "pencil";

/** A color in the editor — sRGB 0..1 floats, with an optional alpha. */
export interface EditorColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A drop shadow for shapes (M6). Rendered on screen with an SVG
 * `feDropShadow` filter; exported to PDF as an offset duplicate path at
 * reduced opacity (pdf-lib has no blur — a documented honest approximation;
 * `blur: 0` exports exactly).
 */
export interface ShapeShadow {
  /** Horizontal offset in local units (+x right). */
  offsetX: number;
  /** Vertical offset in local units (+y down). */
  offsetY: number;
  /** Blur radius in local units (0 = hard shadow). */
  blur: number;
  /** Shadow color (alpha = shadow strength). */
  color: EditorColor;
}

/** Common visual style applied to fillable/strokable objects. */
export interface ObjectStyle {
  fill: EditorColor | null;
  stroke: EditorColor | null;
  strokeWidth: number;
  /** Corner radius for rect/roundedRect shapes, in local units. */
  cornerRadius: number;
  /**
   * Optional dash pattern in local units (e.g. [4, 3]); undefined/empty =
   * solid. Optional so pre-v6 saves deserialize with the solid default.
   */
  dash?: number[];
  /**
   * Optional drop shadow (M6, format v6). null/undefined = no shadow —
   * optional so pre-v6 saves deserialize cleanly.
   */
  shadow?: ShapeShadow | null;
}

/**
 * Fields shared by every editor object. `kind` is the discriminant for the
 * union below. Objects are treated as immutable values: an edit produces a new
 * object with a replaced transform or property rather than mutating in place,
 * which is what makes the command/undo model a stack of pure state transitions.
 */
export interface EditorObjectBase {
  /** Stable unique id (UUID-ish). Used as the React key and selection key. */
  id: string;
  /** The discriminant — which concrete object type this is. */
  kind: EditorObjectKind;
  /** The layer this object belongs to (see {@link import("./layers").Layer}). */
  layerId: string;
  /** Human-readable label shown in the layers panel; defaults to the kind. */
  name: string;
  /**
   * Maps local space → page space. Local space has its origin at the object's
   * own top-left, so the translate component is the object's page-space
   * position. Scale encodes width/height relative to localBounds; rotation is
   * about the local origin.
   */
  transform: AffineTransform;
  /**
   * The object's geometry in LOCAL space (before transform). Width/height here
   * are the "natural" size; the transform's scale magnifies them. Kept separate
   * from the transform so a resize can adjust scale without touching the local
   * geometry, and a content edit (e.g. text length) can grow localBounds
   * without disturbing the placed position.
   */
  localBounds: Bounds;
  /** 0..1 opacity multiplier. */
  opacity: number;
  /** When false the object is not rendered but still occupies its layer slot. */
  visible: boolean;
  /** When true the object ignores pointer interaction (and is skipped by tab). */
  locked: boolean;
  /** Arbitrary, plugin-owned metadata that survives serialization. */
  metadata: Record<string, unknown>;
}

/**
 * The base fields with a widened `kind: string` — the shape reconstruction
 * produces before a kind is known to be built-in or plugin-defined. Used as the
 * `base` argument to a plugin's `deserialize` (which may receive any kind) and
 * as the return type of the serializer's base-field reconstruction.
 */
export type ReconstructedBase = Omit<EditorObjectBase, "kind"> & { kind: string };

/**
 * Provenance for a text object derived from EXISTING PDF text.
 *
 * HISTORY (important for reading the rest of this file). M5 Part 1 created a
 * fully editable `TextObject` for every extracted run, placed over the original
 * with an opaque white `background` that was supposed to "redact" it. That was
 * dishonest: the original still rendered in the page raster and in the exported
 * source page, the copy was re-typeset in a base-14 font so it never aligned
 * exactly, and moving or deleting it revealed the original underneath.
 *
 * Now: an imported run is described by this marker and its
 * {@link ImportedTextEditMode}. A `readonly` run is a NON-RENDERING hit region —
 * it exists so the user can select the text, read its provenance, and copy it,
 * but the canvas and the exporter both skip drawing it, so the original PDF text
 * is the single visible representation. Only a `replace` run draws anything, and
 * only then against a probed background with an independent removal patch.
 *
 * Added in format v3. `mode` was added later and is optional: a marker without
 * it is a LEGACY Part-1 copy, which `normalizeImportedText` classifies on load.
 */
export interface SourceTextInfo {
  /** The PostScript/CSS font name reported by PDF.js for the source run. */
  fontName?: string;
  /** The source text run's rotation in degrees (0/90/180/270), for display. */
  rotation?: number;
  /**
   * How this run may be edited. Absent = a legacy Part-1 editable copy, which
   * load-time normalization resolves to `readonly` (unchanged) or `replace`
   * (user-modified). Never widen the default: absent must not mean editable.
   */
  mode?: ImportedTextEditMode;
  /** The user-facing explanation for a non-`direct` mode, shown in Properties. */
  reason?: string | null;
  /**
   * The verbatim text of the ORIGINAL run, preserved even when the user has
   * typed a replacement over it. This is what "Copy text" yields for a readonly
   * run and what undo restores.
   */
  originalText?: string;
}

/**
 * A text box. `text` and its scalar style fields remain the M1–M5 Part 1
 * compatibility projection. M5 Part 2 adds normalized rich `content` and frame
 * intent; the future TextLayoutEngine is the only authority that may derive
 * wrapped lines, positions, overflow, or measured frame size from those fields.
 *
 * `background` (format v3) is an opaque frame fill behind the text. For
 * editor-authored text it's a styled text-frame background (Part 2 typography);
 * for existing-text replacement objects (Part 1) it's the page color that
 * redacts the original text. `null` = transparent (the pre-v3 behavior).
 */
export interface TextObject extends EditorObjectBase {
  kind: "text";
  /** Legacy plain-text projection retained for old render/export/accessibility paths. */
  text: string;
  /** Normalized rich-text source added in format v4. */
  content: TextContent;
  /** Persisted layout intent added in format v4; resolved layout is never stored. */
  frame: TextFrame;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  color: EditorColor;
  align: "left" | "center" | "right";
  lineHeight: number;
  /**
   * Inter-character spacing in local font-size units (em * 1000 style: 0 = default).
   * Added in format v2; optional so v1 saves deserialize with the 0 default.
   */
  letterSpacing?: number;
  /**
   * Word spacing in local units. Added in M5.
   */
  wordSpacing?: number;
  /**
   * Paragraph spacing in local units. Added in M5.
   */
  paragraphSpacing?: number;
  /**
   * Opaque fill behind the text box (text-frame background / existing-text
   * redaction). `null`/`undefined` = transparent. Added in format v3; optional
   * so v1/v2 saves deserialize with the null default.
   */
  background?: EditorColor | null;
  /**
   * When set, this text object was derived from existing PDF text (Part 1) and
   * the UI labels it "Existing text". Added in format v3; optional.
   */
  sourceText?: SourceTextInfo | null;
}

/** A raster image referenced by an embeddable src (data URL or asset key). */
export interface ImageObject extends EditorObjectBase {
  kind: "image";
  src: string;
  /** Natural pixel dimensions; localBounds is derived from these + a scale. */
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  /**
   * Optional crop rectangle in NATURAL pixel coordinates (the sub-region of the
   * source to display). null/undefined = show the whole image. Added in format
   * v2; optional so v1 saves deserialize with the null default.
   */
  crop?: Bounds | null;
}

/**
 * A vector shape. The geometry for every {@link ShapeKind} derives from
 * `localBounds` plus the optional per-kind parameters below (all clamped by
 * `shapeGeometry.ts`, the single source of truth for path data). Parameters are
 * optional (format v6) so pre-v6 saves deserialize with the defaults.
 */
export interface ShapeObject extends EditorObjectBase {
  kind: "shape";
  shape: ShapeKind;
  style: ObjectStyle;
  /**
   * For polygon/line/connector: explicit vertices in local space. Empty =
   * derive from localBounds (line/connector default to the TL→BR diagonal;
   * polygon falls back to a regular n-gon of {@link sides}).
   */
  points: Point[];
  /** polygon: number of sides of the regular n-gon (3–12, default 6). */
  sides?: number;
  /** star: number of points (4–12, default 5). */
  starPoints?: number;
  /** star: inner/outer radius ratio (0.1–0.9, default 0.5). */
  innerRatio?: number;
  /** arrow/connector: arrowhead size in local units (default 16). */
  headSize?: number;
  /** arrow: arrowhead style (default "triangle"). */
  headType?: ArrowHeadType;
  /** speechBubble: normalized tail position along the bottom edge (0–1, default 0.3). */
  tailPosition?: number;
  /** connector: routing (default "straight"). */
  connectorKind?: ConnectorKind;
  /** connector: draw an arrowhead at the start point (default false). */
  startArrow?: boolean;
  /** connector: draw an arrowhead at the end point (default true). */
  endArrow?: boolean;
  /**
   * bezier/path: SVG path data in LOCAL coordinates (absolute M/L/C/Q/Z
   * commands, normalized so the path's tight bounds start at (0,0) and match
   * `localBounds`). Produced by the PathBuilder tool.
   */
  pathData?: string;
}

/**
 * A text annotation (the existing annotate tool's note, as an object).
 *
 * THE CONTAINER IS DOCUMENT DATA, not a renderer decoration. It used to be
 * neither: `AnnotationContent` hardcoded `fill="rgba(255,245,180,0.95)"` and a
 * 1px border, so the sticky-note panel every user saw had no representation in
 * the model — nothing to serialize, nothing to restore, and nothing for the PDF
 * exporter to draw. A note that looked yellow on the canvas exported as bare
 * floating text, and the yellow was reported lost on reload because it had never
 * been saved in the first place. These three fields are that panel.
 */
export interface AnnotationObject extends EditorObjectBase {
  kind: "annotation";
  text: string;
  fontSize: number;
  color: EditorColor;
  /** Optional pointer arrow from the note to a target point in local space. */
  pointerTarget: Point | null;
  /**
   * The note panel's fill. `null` means a genuinely transparent note (text
   * only) — distinct from a missing field, which older documents have and
   * migration 6→7 backfills with {@link DEFAULT_ANNOTATION_BACKGROUND}.
   */
  background: EditorColor | null;
  /** The panel's border color; `null` draws no border. */
  border: EditorColor | null;
  /** Border width in local units. 0 draws no border regardless of `border`. */
  borderWidth: number;
  /** Corner radius in local units (the historical note look is 6). */
  cornerRadius: number;
}

/** A placed signature image (visual, not cryptographic — mirrors signPdf). */
export interface SignatureObject extends EditorObjectBase {
  kind: "signature";
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Signer label captured at placement time, for the audit trail. */
  signer: string;
}

/** A translucent highlight rectangle drawn over content (multiply blend). */
export interface HighlightObject extends EditorObjectBase {
  kind: "highlight";
  color: EditorColor;
}

/**
 * A freehand drawing stored as a polyline in local space. M6 (format v6) adds
 * brush metadata; the rendered geometry (smoothing, pressure outline, pencil
 * jitter) derives from these fields via the shared `drawingGeometry.ts` module
 * so the on-screen SVG and the PDF export agree by construction.
 */
export interface DrawingObject extends EditorObjectBase {
  kind: "drawing";
  points: Point[];
  style: ObjectStyle;
  /**
   * Brush the stroke was drawn with (default "pen" — the pre-v6 behavior).
   * Marker/highlighter render translucent (highlighter with multiply blend);
   * pencil renders 1px with a deterministic per-point jitter texture.
   */
  brush?: BrushKind;
  /**
   * When true the rendered path is the Catmull-Rom→cubic-Bezier smoothing of
   * `points` (derived, never stored). Default false — old strokes were drawn
   * unsmoothed and must render identically.
   */
  smoothing?: boolean;
  /**
   * Optional per-point stroke widths (parallel to `points`) produced by the
   * velocity-based pressure simulation. When present the stroke renders as a
   * filled variable-width outline instead of a constant-width stroke.
   */
  widths?: number[];
}

/** The discriminated union of all built-in editor objects. */
export type AnyEditorObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | AnnotationObject
  | SignatureObject
  | HighlightObject
  | DrawingObject;

/** Any object — built-in union or a plugin-registered kind (opaque to core). */
export type EditorObject = AnyEditorObject | PluginEditorObject;

/**
 * A plugin-registered object carries its kind as a string beyond the built-in
 * union, plus an opaque payload the plugin owns (serialize/deserialize/render).
 * The core never inspects `data`; it only stores, selects, transforms, and
 * layers it. This is how the editor gains new object types without core changes.
 *
 * `kind` is `Omit`-ed from the base and widened to `string` so a plugin's kind
 * (e.g. "stamp") can sit alongside the built-in union without a type conflict.
 */
export interface PluginEditorObject extends Omit<EditorObjectBase, "kind"> {
  kind: string; // not one of EditorObjectKind — plugin-defined
  data: unknown;
}

/** A type guard narrowing the union to a specific kind. */
export function isObjectKind<K extends EditorObjectKind>(
  obj: EditorObject,
  kind: K,
): obj is Extract<AnyEditorObject, { kind: K }> {
  return obj.kind === kind;
}

/** The default style for newly-created fillable objects (transparent fill, no stroke). */
export const DEFAULT_STYLE: ObjectStyle = {
  fill: null,
  stroke: null,
  strokeWidth: 0,
  cornerRadius: 0,
};

/** A sensible default color (opaque near-black) for new text/annotation objects. */
export const DEFAULT_TEXT_COLOR: EditorColor = { r: 0.07, g: 0.09, b: 0.15, a: 1 };

/** The signature highlight yellow used by the existing tools. */
export const DEFAULT_HIGHLIGHT_COLOR: EditorColor = {
  r: 1,
  g: 0.93,
  b: 0.4,
  a: 0.4,
};

/** Default letter spacing for new text objects (no extra spacing). */
export const DEFAULT_LETTER_SPACING = 0;

/**
 * The sticky-note yellow, as document data.
 *
 * These three constants are the ONE place the note panel's look is defined. They
 * are read by the canvas renderer, by the PDF exporter, by the annotate tool's
 * factory and by the 6→7 migration that backfills notes saved before the panel
 * was part of the model — which is the whole point of centralizing them: a
 * renderer that invents its own yellow is a renderer the exporter disagrees with.
 *
 * The value is the historical `rgba(255,245,180,0.95)` the canvas hardcoded, to
 * three decimals, so existing notes look unchanged.
 */
export const DEFAULT_ANNOTATION_BACKGROUND: EditorColor = {
  r: 1,
  g: 0.961,
  b: 0.706,
  a: 0.95,
};

/** The note panel's border width (the historical 1px hairline). */
export const DEFAULT_ANNOTATION_BORDER_WIDTH = 1;

/** The note panel's corner radius (the historical `rx`/`ry` of 6). */
export const DEFAULT_ANNOTATION_CORNER_RADIUS = 6;

// ---------------------------------------------------------------------------
// Grouping (Part 9). A group is expressed through an object's `metadata.groupId`
// rather than a dedicated field, so the core object model + serialization shape
// stay stable (a group id is just metadata that survives save/load). These
// typed accessors keep call-sites clean and centralize the key name.
// ---------------------------------------------------------------------------

/** The metadata key under which an object's group id is stored. */
export const GROUP_METADATA_KEY = "groupId";

/** Returns the object's group id, or null if it is not part of a group. */
export function getGroupId(obj: EditorObject): string | null {
  const v = obj.metadata?.[GROUP_METADATA_KEY];
  return typeof v === "string" ? v : null;
}

/** Returns a new object with its group id set (a group of one is still valid). */
export function setGroupId<T extends EditorObject>(obj: T, groupId: string | null): T {
  const next = groupId === null ? { ...obj.metadata } : { ...obj.metadata, [GROUP_METADATA_KEY]: groupId };
  if (groupId === null) delete next[GROUP_METADATA_KEY];
  return { ...obj, metadata: next };
}

/** True when two objects share the same (non-null) group id. */
export function sameGroup(a: EditorObject, b: EditorObject): boolean {
  const ga = getGroupId(a);
  const gb = getGroupId(b);
  return ga !== null && ga === gb;
}
