import { type AffineTransform, type Bounds, type Point, makeBounds, makeTranslate } from "./geometry";
import { generateId } from "./ids";
import { SHAPE_KIND_LABELS } from "./shapeGeometry";
import { createDefaultTextFrame, createPlainTextContent, textContentToPlainText } from "./textContent";
import {
  DEFAULT_ANNOTATION_BACKGROUND,
  DEFAULT_ANNOTATION_BORDER_WIDTH,
  DEFAULT_ANNOTATION_CORNER_RADIUS,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_LETTER_SPACING,
  DEFAULT_STYLE,
  DEFAULT_TEXT_COLOR,
  type AnnotationObject,
  type DrawingObject,
  type HighlightObject,
  type ImageObject,
  type ShapeKind,
  type ShapeObject,
  type SignatureObject,
  type TextObject,
} from "./objects";

/**
 * Production factories for creating NEW editor objects with sensible defaults,
 * placed at a page-space `position`. The M3.e test factories
 * (`./testFactories.ts`) use deterministic ids for tests; these use
 * {@link generateId} for real objects the toolbar/clipboard emit.
 *
 * Every factory returns a fully-populated, immutable object valid against the
 * current serializer shape (v2): text carries `letterSpacing`, image carries
 * `crop`, and `metadata` is empty (grouping is added later via setGroupId).
 */

/**
 * The fields shared by every object kind, derived from placement + bounds.
 *
 * `transformOverride` lets a caller supply a full affine transform instead of a
 * plain `position`. The only current consumer is M5 Part 1 existing-text
 * extraction, which encodes the baseline position, rotation, and the
 * baseline-to-top shift in one composed transform (it passes `position: (0,0)`
 * and the real placement via the override). When omitted, the object's local
 * origin sits at `position` in page space, as before.
 */
function baseFields(
  layerId: string,
  name: string,
  position: Point,
  localBounds: Bounds,
  transformOverride?: AffineTransform,
) {
  return {
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {} as Record<string, unknown>,
    transform: transformOverride ?? makeTranslate(position.x, position.y),
    localBounds,
    layerId,
    name,
  };
}

/** Resolves an object id: an explicit override, otherwise a fresh generated id. */
function resolveId(overrides: { id?: string }, prefix = "obj"): string {
  return overrides.id ?? generateId(prefix);
}

/** The font size a new text object gets when the caller does not specify one. */
export const DEFAULT_TEXT_FONT_SIZE = 16;
/** The line height a new text object gets when the caller does not specify one. */
export const DEFAULT_TEXT_LINE_HEIGHT = 1.2;

/** Creates a text box at `position` with default Helvetica 16px content. */
export function createTextObject(
  position: Point,
  layerId: string,
  overrides: Partial<TextObject> = {},
): TextObject {
  const fontSize = overrides.fontSize ?? DEFAULT_TEXT_FONT_SIZE;
  const lineHeight = overrides.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const height = overrides.localBounds?.height ?? Math.ceil(fontSize * lineHeight);
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, 200, height);
  // `content` is the v4 source of truth when supplied. The scalar `text` stays
  // synchronized as its compatibility projection for the current M4 renderer,
  // M5 Part 1 extraction/export path, and accessibility consumers.
  const content = overrides.content ?? createPlainTextContent(overrides.text ?? "Text");
  return {
    id: resolveId(overrides),
    kind: "text",
    ...baseFields(layerId, overrides.name ?? "Text", position, localBounds, overrides.transform),
    text: textContentToPlainText(content),
    content,
    frame: overrides.frame ?? createDefaultTextFrame(),
    fontSize,
    fontFamily: overrides.fontFamily ?? "Helvetica",
    fontWeight: overrides.fontWeight ?? 400,
    color: overrides.color ?? DEFAULT_TEXT_COLOR,
    align: overrides.align ?? "left",
    lineHeight,
    letterSpacing: overrides.letterSpacing ?? DEFAULT_LETTER_SPACING,
    background: overrides.background ?? null,
    sourceText: overrides.sourceText ?? null,
  };
}

/** Creates an image object at `position`, scaled to fit within a 240px box. */
export function createImageObject(
  position: Point,
  layerId: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  overrides: Partial<ImageObject> = {},
): ImageObject {
  const maxBox = 240;
  const scale = Math.min(maxBox / naturalWidth, maxBox / naturalHeight, 1);
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, naturalWidth * scale, naturalHeight * scale);
  return {
    id: resolveId(overrides),
    kind: "image",
    ...baseFields(layerId, overrides.name ?? "Image", position, localBounds, overrides.transform),
    src,
    naturalWidth,
    naturalHeight,
    alt: overrides.alt ?? "Image",
    crop: overrides.crop ?? null,
  };
}

/**
 * True for the stroke-only shape kinds (no fill makes sense): line, connector,
 * and the click-built bezier/path curves.
 */
function isStrokeOnlyShape(shape: ShapeKind): boolean {
  return shape === "line" || shape === "connector" || shape === "bezier" || shape === "path";
}

/** Creates a vector shape at `position` with sensible per-kind defaults. */
export function createShapeObject(
  position: Point,
  layerId: string,
  shape: ShapeKind,
  overrides: Partial<ShapeObject> = {},
): ShapeObject {
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, 120, 120);
  const violet = { r: 0.486, g: 0.227, b: 0.929, a: 1 };
  // Stroke-only kinds default to a stroked style; fillable kinds keep the
  // pre-M6 violet fill so existing behavior (rect/ellipse/polygon) is unchanged.
  const style = overrides.style ?? (isStrokeOnlyShape(shape)
    ? { ...DEFAULT_STYLE, stroke: violet, strokeWidth: 2 }
    : { ...DEFAULT_STYLE, fill: violet });
  return {
    id: resolveId(overrides),
    kind: "shape",
    ...baseFields(layerId, overrides.name ?? shapeLabel(shape), position, localBounds, overrides.transform),
    shape,
    style,
    points: overrides.points ?? [],
    ...(overrides.sides !== undefined ? { sides: overrides.sides } : {}),
    ...(overrides.starPoints !== undefined ? { starPoints: overrides.starPoints } : {}),
    ...(overrides.innerRatio !== undefined ? { innerRatio: overrides.innerRatio } : {}),
    ...(overrides.headSize !== undefined ? { headSize: overrides.headSize } : {}),
    ...(overrides.headType !== undefined ? { headType: overrides.headType } : {}),
    ...(overrides.tailPosition !== undefined ? { tailPosition: overrides.tailPosition } : {}),
    ...(overrides.connectorKind !== undefined ? { connectorKind: overrides.connectorKind } : {}),
    ...(overrides.startArrow !== undefined ? { startArrow: overrides.startArrow } : {}),
    ...(overrides.endArrow !== undefined ? { endArrow: overrides.endArrow } : {}),
    ...(overrides.pathData !== undefined ? { pathData: overrides.pathData } : {}),
  };
}

/** Creates a translucent highlight rectangle at `position`. */
export function createHighlight(
  position: Point,
  layerId: string,
  overrides: Partial<HighlightObject> = {},
): HighlightObject {
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, 160, 28);
  return {
    id: resolveId(overrides),
    kind: "highlight",
    ...baseFields(layerId, overrides.name ?? "Highlight", position, localBounds, overrides.transform),
    color: overrides.color ?? DEFAULT_HIGHLIGHT_COLOR,
  };
}

/** Creates a freehand drawing at `position` (a polyline in local space). */
export function createDrawing(
  position: Point,
  layerId: string,
  points: Point[],
  overrides: Partial<DrawingObject> = {},
): DrawingObject {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = points.length ? Math.min(...xs) : 0;
  const minY = points.length ? Math.min(...ys) : 0;
  const maxX = points.length ? Math.max(...xs) : 0;
  const maxY = points.length ? Math.max(...ys) : 0;
  const localBounds = overrides.localBounds ?? makeBounds(minX, minY, Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));
  return {
    id: resolveId(overrides),
    kind: "drawing",
    ...baseFields(layerId, overrides.name ?? "Drawing", position, localBounds, overrides.transform),
    points: points.length ? points : [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    style: overrides.style ?? { ...DEFAULT_STYLE, stroke: { r: 0.07, g: 0.09, b: 0.15, a: 1 }, strokeWidth: 2 },
    ...(overrides.brush !== undefined ? { brush: overrides.brush } : {}),
    ...(overrides.smoothing !== undefined ? { smoothing: overrides.smoothing } : {}),
    ...(overrides.widths !== undefined ? { widths: overrides.widths } : {}),
  };
}

/** Creates a text annotation (note) at `position`. */
export function createAnnotation(
  position: Point,
  layerId: string,
  overrides: Partial<AnnotationObject> = {},
): AnnotationObject {
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, 160, 60);
  return {
    id: resolveId(overrides),
    kind: "annotation",
    ...baseFields(layerId, overrides.name ?? "Note", position, localBounds, overrides.transform),
    text: overrides.text ?? "Note",
    fontSize: overrides.fontSize ?? 12,
    color: overrides.color ?? DEFAULT_TEXT_COLOR,
    pointerTarget: overrides.pointerTarget ?? null,
    /*
     * The note panel. `??` rather than `||` on purpose: an explicit `null`
     * background is a caller asking for a transparent, text-only note, and
     * collapsing that to the default yellow would make transparency
     * unexpressible.
     */
    background: overrides.background !== undefined ? overrides.background : DEFAULT_ANNOTATION_BACKGROUND,
    // The historical look drew the hairline in the note's own text color.
    border: overrides.border !== undefined ? overrides.border : (overrides.color ?? DEFAULT_TEXT_COLOR),
    borderWidth: overrides.borderWidth ?? DEFAULT_ANNOTATION_BORDER_WIDTH,
    cornerRadius: overrides.cornerRadius ?? DEFAULT_ANNOTATION_CORNER_RADIUS,
  };
}

/** Creates a placed signature image at `position`. */
export function createSignature(
  position: Point,
  layerId: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  signer: string,
  overrides: Partial<SignatureObject> = {},
): SignatureObject {
  const maxBox = 200;
  const scale = Math.min(maxBox / naturalWidth, maxBox / naturalHeight, 1);
  const localBounds = overrides.localBounds ?? makeBounds(0, 0, naturalWidth * scale, naturalHeight * scale);
  return {
    id: resolveId(overrides),
    kind: "signature",
    ...baseFields(layerId, overrides.name ?? "Signature", position, localBounds, overrides.transform),
    src,
    naturalWidth,
    naturalHeight,
    signer,
  };
}

/** Human-readable label for a shape kind (from the canonical geometry module). */
export function shapeLabel(shape: ShapeKind): string {
  return SHAPE_KIND_LABELS[shape];
}
