import { IDENTITY_TRANSFORM, makeBounds, makeTranslate } from "./geometry";
import { addObjectToPage, createEditorState } from "./document";
import type { EditorPage, EditorState } from "./document";
import type { EditorObject } from "./objects";
import type {
  AnnotationObject,
  DrawingObject,
  HighlightObject,
  ImageObject,
  ShapeObject,
  SignatureObject,
  TextObject,
} from "./objects";
import {
  DEFAULT_ANNOTATION_BACKGROUND,
  DEFAULT_ANNOTATION_BORDER_WIDTH,
  DEFAULT_ANNOTATION_CORNER_RADIUS,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_STYLE,
  DEFAULT_TEXT_COLOR,
} from "./objects";
import { createDefaultTextFrame, createPlainTextContent, textContentToPlainText } from "./textContent";

/**
 * Shared factories for editor tests. Deterministic ids via an injected counter
 * so tests can assert against stable ids; call {@link resetFactory} in
 * `beforeEach` to keep tests independent.
 */
let n = 0;
export function resetFactory(): void {
  n = 0;
}
const id = (prefix: string) => `${prefix}-${++n}`;

export function makeTextObject(overrides: Partial<TextObject> = {}): TextObject {
  const content = overrides.content ?? createPlainTextContent(overrides.text ?? "Hello");
  return {
    id: id("obj"),
    kind: "text",
    layerId: "layer-1",
    name: "Text",
    transform: makeTranslate(10, 20),
    localBounds: makeBounds(0, 0, 100, 20),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    fontSize: 14,
    fontFamily: "Helvetica",
    fontWeight: 400,
    color: DEFAULT_TEXT_COLOR,
    align: "left",
    lineHeight: 1.2,
    letterSpacing: 0,
    wordSpacing: 0,
    paragraphSpacing: 0,
    ...overrides,
    text: textContentToPlainText(content),
    content,
    frame: overrides.frame ?? createDefaultTextFrame(),
  };
}

export function makeRect(overrides: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id: id("obj"),
    kind: "shape",
    shape: "rect",
    layerId: "layer-1",
    name: "Rect",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 80, 60),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    style: { ...DEFAULT_STYLE, fill: { r: 1, g: 0, b: 0, a: 1 } },
    points: [],
    ...overrides,
  };
}

export function makeImage(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id: id("obj"),
    kind: "image",
    layerId: "layer-1",
    name: "Image",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 200, 100),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    src: "data:image/png;base64,AAA",
    naturalWidth: 200,
    naturalHeight: 100,
    alt: "test",
    crop: null,
    ...overrides,
  };
}

/** A placed signature image (visual, not cryptographic). */
export function makeSignature(overrides: Partial<SignatureObject> = {}): SignatureObject {
  return {
    id: id("obj"),
    kind: "signature",
    layerId: "layer-1",
    name: "Signature",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 180, 60),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    src: "data:image/png;base64,AAA",
    naturalWidth: 360,
    naturalHeight: 120,
    signer: "Signer",
    ...overrides,
  };
}

export function makeHighlight(overrides: Partial<HighlightObject> = {}): HighlightObject {
  return {
    id: id("obj"),
    kind: "highlight",
    layerId: "layer-1",
    name: "Highlight",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 120, 24),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    color: DEFAULT_HIGHLIGHT_COLOR,
    ...overrides,
  };
}

/** The annotate tool's note, as an object (text lives in the Inspector field). */
export function makeAnnotation(overrides: Partial<AnnotationObject> = {}): AnnotationObject {
  return {
    id: id("obj"),
    kind: "annotation",
    layerId: "layer-1",
    name: "Note",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 160, 40),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    text: "Note",
    fontSize: 12,
    color: DEFAULT_TEXT_COLOR,
    pointerTarget: null,
    background: DEFAULT_ANNOTATION_BACKGROUND,
    border: DEFAULT_TEXT_COLOR,
    borderWidth: DEFAULT_ANNOTATION_BORDER_WIDTH,
    cornerRadius: DEFAULT_ANNOTATION_CORNER_RADIUS,
    ...overrides,
  };
}

export function makeDrawing(overrides: Partial<DrawingObject> = {}): DrawingObject {
  return {
    id: id("obj"),
    kind: "drawing",
    layerId: "layer-1",
    name: "Drawing",
    transform: IDENTITY_TRANSFORM,
    localBounds: makeBounds(0, 0, 50, 50),
    opacity: 1,
    visible: true,
    locked: false,
    metadata: {},
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ],
    style: { ...DEFAULT_STYLE, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 2 },
    ...overrides,
  };
}

/** A state with `count` rect objects on the default page, stacked in order. */
export function makeStateWithRects(count: number): EditorState {
  const initial = createEditorState();
  let page: EditorPage = initial.document.pages[0];
  for (let i = 0; i < count; i++) {
    const rect: EditorObject = makeRect();
    page = addObjectToPage(page, rect);
  }
  return {
    ...initial,
    document: { ...initial.document, pages: [page] },
  };
}
