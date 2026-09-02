import type { ShapeKind } from "@/src/domain/editor/objects";

/**
 * The canonical editor tool union (M6). This file is the single source of
 * truth for tool identifiers — the toolbar layout (`toolbarLayout.ts`), the
 * canvas, the shortcut system, the status bar, and accessibility labels all
 * consume these ids. Adding a tool means adding it here, then registering its
 * metadata once in `toolbarLayout.ts`.
 */
export type EditorTool =
  // Navigation
  | "select"
  | "hand"
  // Content insertion
  | "text"
  | "image"
  | "signature"
  | "annotation"
  // Shape tools (each maps 1:1 to a ShapeKind via SHAPE_TOOL_KINDS)
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
  // Freehand / markup
  | "draw"
  | "highlight"
  | "eraser"
  | "path"
  // Modify
  | "crop";

/** Every tool id exactly once, in canonical order (toolbar order). */
export const ALL_EDITOR_TOOLS: readonly EditorTool[] = [
  "select",
  "hand",
  "text",
  "image",
  "signature",
  "annotation",
  "rect",
  "roundedRect",
  "ellipse",
  "circle",
  "triangle",
  "line",
  "arrow",
  "polygon",
  "star",
  "speechBubble",
  "connector",
  "draw",
  "highlight",
  "eraser",
  "path",
  "crop",
];

/**
 * The shape tools' 1:1 mapping onto the domain {@link ShapeKind}s. Box-drag
 * creation on the canvas resolves the kind through this map, so the toolbar
 * and the domain never disagree about which kinds exist as tools.
 */
export const SHAPE_TOOL_KINDS: Readonly<Partial<Record<EditorTool, ShapeKind>>> = {
  rect: "rect",
  roundedRect: "roundedRect",
  ellipse: "ellipse",
  circle: "circle",
  triangle: "triangle",
  line: "line",
  arrow: "arrow",
  polygon: "polygon",
  star: "star",
  speechBubble: "speechBubble",
  connector: "connector",
};

/** The ShapeKind a shape tool creates, or null for non-shape tools. */
export function shapeKindForTool(tool: EditorTool): ShapeKind | null {
  return SHAPE_TOOL_KINDS[tool] ?? null;
}

/** Narrowing guard for strings coming from storage/URLs/unknown sources. */
export function isEditorTool(value: string): value is EditorTool {
  return (ALL_EDITOR_TOOLS as readonly string[]).includes(value);
}

/**
 * True for the tools that create an object through canvas interaction.
 * Navigation (select/hand), the eraser (removes), and crop (edits an existing
 * image) are not creation tools.
 */
export function isCreationTool(tool: EditorTool): boolean {
  return tool !== "select" && tool !== "hand" && tool !== "eraser" && tool !== "crop";
}

/** True for the tools that drag out a bounding box (all shape tools + highlight). */
export function isBoxTool(tool: EditorTool): boolean {
  return tool === "highlight" || shapeKindForTool(tool) !== null;
}

/**
 * True for the freehand/stroke tools whose behavior is governed by the Draw
 * brush settings (brush, color, width, opacity).
 *
 * The eraser is excluded: it removes strokes rather than producing one, so the
 * brush controls would not describe it. "path" (the Bézier pen) IS included —
 * it draws with the same ink.
 */
export function isDrawingTool(tool: EditorTool): boolean {
  return tool === "draw" || tool === "path";
}
