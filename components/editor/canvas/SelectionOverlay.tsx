"use client";

import { pageToScreen, type PageScreenOrigin, type Viewport } from "@/src/application/editor/coordinates/CoordinateSpace";
import type { Bounds } from "@/src/domain/editor/geometry";
import type { ResizeHandle } from "@/src/application/editor/transform/TransformService";
import type { SelectionAffordance } from "@/components/editor/canvas/selectionAffordances";
import {
  HANDLE_HIT,
  handleCursor,
  handleHitRect,
  handleInwardExtent,
  handleVisualSize,
  rotateCentreY,
  rotateSide,
  visibleHandles,
} from "@/components/editor/canvas/selectionChrome";
import {
  DRAFT_EDGE,
  DRAFT_TINT,
  DRAFT_TINT_STRONG,
  SELECTION,
  SELECTION_HALO,
  SELECTION_HALO_WIDTH,
} from "@/components/editor/canvas/signalColors";

/**
 * The selection chrome drawn above the objects: the selection box with its resize
 * handles + a rotate handle, the marquee rectangle (during drag-select), and the
 * active snap guide lines (during a snapped drag). Everything is positioned in
 * CONTAINER screen space — the caller passes the page-space selection bounds +
 * viewport + origin (pan), and we convert with `pageToScreen`.
 *
 * NOT every selection gets that chrome. A read-only imported PDF run is marked
 * the way a PDF VIEWER marks selected text — a translucent range highlight — and
 * gets no handles at all, because move/resize/rotate are not operations it
 * supports. An object whose inline text editor is OPEN gets nothing here at all:
 * the editing surface has its own ring, and the handles were inert while editing.
 * Both verdicts come from `resolveSelectionAffordance` / `affordanceWhileEditing`
 * so this component and the Properties panel cannot disagree about them.
 *
 * WHICH handles are drawn, how deep their pointer targets reach and which side the
 * rotate handle takes are all decided by `selectionChrome` — a pure module, so the
 * thresholds are testable without a DOM and cannot be re-guessed here. Read its
 * header for the browser measurements that produced them; the short version is
 * that a fixed eight-handle box with fixed 24px targets covered a small on-screen
 * selection completely, leaving 1 of 25 sampled interior points able to start a
 * move, and a fixed `y - 28` rotate handle is CLIPPED by this svg (computed
 * `overflow: hidden`) whenever the selection sits near the top of the canvas.
 *
 * Every stroke is also drawn twice: a light halo first, the accent on top. A 1.5px
 * violet line is the only thing distinguishing selected from not, and over a dark
 * image or a violet-filled shape it disappears. The halo costs one extra node per
 * stroked element and makes the frame legible on any content.
 */
export interface SnapGuide {
  /** A vertical guide at this page-space x, or a horizontal one at this y. */
  x?: number;
  y?: number;
}

export interface SelectionOverlayProps {
  selectionBounds: Bounds | null;
  viewport: Viewport;
  origin: PageScreenOrigin;
  /** Page-space marquee rectangle while drag-selecting, else null. */
  marquee: Bounds | null;
  /** Active snap guides to render during a drag. */
  snapGuides: SnapGuide[];
  /** Show the rotate handle (single-object selection only). */
  showRotateHandle: boolean;
  /**
   * What chrome this selection may show. Defaults to the full transform box so
   * existing callers keep their behavior; a `source-text` affordance replaces the
   * box + handles with a read-only text-range highlight.
   */
  affordance?: SelectionAffordance;
  onHandlePointerDown: (handle: ResizeHandle | "rotate", e: React.PointerEvent) => void;
}

/** Maps a handle to its fractional position on the bounds (0/0.5/1 of w/h). */
function handleFraction(h: ResizeHandle): { fx: number; fy: number } {
  switch (h) {
    case "nw": return { fx: 0, fy: 0 };
    case "n": return { fx: 0.5, fy: 0 };
    case "ne": return { fx: 1, fy: 0 };
    case "e": return { fx: 1, fy: 0.5 };
    case "se": return { fx: 1, fy: 1 };
    case "s": return { fx: 0.5, fy: 1 };
    case "sw": return { fx: 0, fy: 1 };
    case "w": return { fx: 0, fy: 0.5 };
  }
}

function pageBoundsToScreen(b: Bounds, viewport: Viewport, origin: PageScreenOrigin) {
  const tl = pageToScreen(viewport, origin, { x: b.x, y: b.y });
  return { x: tl.x, y: tl.y, width: b.width * viewport.zoom, height: b.height * viewport.zoom };
}

/**
 * The selection colour comes from the shared canvas signal palette — it is NOT
 * the brand violet.
 *
 * It used to be `#7C3AED` repeated nine times in this file (the frame, every
 * handle, the rotate line and circle, the marquee), which was both a hue waiting
 * to drift one element at a time AND the same violet as `editor-accent`. That
 * second part was the real defect: with brand chrome, the armed tool, the
 * selection outline and the alignment guides all one colour, a selected object's
 * outline could not be told apart from a snap guide crossing it. `signalColors`
 * holds the three distinct hues and the reasoning.
 */
const ACCENT = SELECTION;
const HALO = SELECTION_HALO;
const HALO_WIDTH = SELECTION_HALO_WIDTH;
const STROKE_WIDTH = 1.5;

/** The default: a normal editable object showing the full transform box. */
const FULL_TRANSFORM: SelectionAffordance = {
  kind: "transform",
  showHandles: true,
  showRotate: true,
  allowsGeometry: true,
};

export function SelectionOverlay({
  selectionBounds,
  viewport,
  origin,
  marquee,
  snapGuides,
  showRotateHandle,
  affordance = FULL_TRANSFORM,
  onHandlePointerDown,
}: SelectionOverlayProps) {
  const box = selectionBounds ? pageBoundsToScreen(selectionBounds, viewport, origin) : null;
  // A read-only imported run is marked, not framed: no transform affordances at
  // all. Rendering the box-and-handles here is exactly the contradiction the
  // capability model exists to prevent.
  const isSourceText = affordance.kind === "source-text";
  // While the inline text editor is open the canvas draws NOTHING for the
  // selection: the editing surface carries its own ring, and every handle is
  // refused by `onHandlePointerDown` while editing, so a frame with eight inert
  // handles was chrome describing operations that could not happen.
  const isEditing = affordance.kind === "text-editing";
  const showHandles = affordance.showHandles;
  // Rotate needs BOTH the caller's single-selection rule and the affordance.
  const showRotate = showRotateHandle && affordance.showRotate;

  return (
    <g pointerEvents="none">
      {/* Read-only source-PDF text: a translucent text-range highlight, the way a
          PDF viewer marks selected text. Communicated as an image with a label so
          the read-only state is available non-visually too (Phase 23). */}
      {box && isSourceText ? (
        <g role="img" aria-label="Original PDF text selected (read-only)">
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={DRAFT_TINT_STRONG}
            stroke={DRAFT_EDGE}
            strokeWidth={1}
            rx={2}
          />
          {/* A baseline rule reads as "text range", distinguishing this from an
              object frame even at a glance. */}
          <line
            x1={box.x}
            y1={box.y + box.height}
            x2={box.x + box.width}
            y2={box.y + box.height}
            stroke={ACCENT}
            strokeWidth={STROKE_WIDTH}
          />
        </g>
      ) : null}

      {/* Selection box + handles (editable objects only) */}
      {box && !isSourceText && !isEditing ? (() => {
        const inward = handleInwardExtent(box.width, box.height);
        const visual = handleVisualSize(inward);
        const handles = showHandles ? visibleHandles(box.width, box.height) : [];
        const side = rotateSide(box.y);
        const rotateCy = rotateCentreY(box, side);
        const rotateAnchorY = side === "above" ? box.y : box.y + box.height;
        const rotateR = visual > 0 ? visual / 2 + 1 : 5.5;
        return (
        <g>
          {/* The frame, haloed. Two nodes rather than one so it survives being
              drawn over a dark image or an accent-filled shape. */}
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke={HALO}
            strokeWidth={HALO_WIDTH}
          />
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke={ACCENT}
            strokeWidth={STROKE_WIDTH}
          />
          {handles.map((h) => {
            const { fx, fy } = handleFraction(h);
            const cx = box.x + fx * box.width;
            const cy = box.y + fy * box.height;
            const hit = handleHitRect(h, box, inward);
            return (
              <g key={h}>
                {/* The pointer target: still the full 24px WCAG 2.2 AA square, but
                    biased OUTWARD so it does not eat the selection's interior.
                    Which handles exist at this size, and how deep they reach, is
                    `selectionChrome`'s decision — see its header for the
                    measurement that motivated both. */}
                <rect
                  x={hit.x}
                  y={hit.y}
                  width={hit.size}
                  height={hit.size}
                  fill="rgba(0,0,0,0)"
                  style={{ cursor: handleCursor(h), pointerEvents: "all" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onHandlePointerDown(h, e);
                  }}
                  aria-label={`${h} resize handle`}
                  role="button"
                />
                <rect
                  x={cx - visual / 2}
                  y={cy - visual / 2}
                  width={visual}
                  height={visual}
                  rx={1.5}
                  fill="#ffffff"
                  stroke={ACCENT}
                  strokeWidth={STROKE_WIDTH}
                  pointerEvents="none"
                />
              </g>
            );
          })}
          {showRotate ? (
            <g>
              {/* Above the selection normally; below it when the selection is near
                  the top of the canvas, because this svg clips (`overflow:
                  hidden`) and a handle at a negative y is simply gone. */}
              <line
                x1={box.x + box.width / 2}
                y1={rotateAnchorY}
                x2={box.x + box.width / 2}
                y2={rotateCy}
                stroke={HALO}
                strokeWidth={HALO_WIDTH}
              />
              <line
                x1={box.x + box.width / 2}
                y1={rotateAnchorY}
                x2={box.x + box.width / 2}
                y2={rotateCy}
                stroke={ACCENT}
                strokeWidth={STROKE_WIDTH}
              />
              <circle
                cx={box.x + box.width / 2}
                cy={rotateCy}
                r={rotateR}
                fill="#ffffff"
                stroke={ACCENT}
                strokeWidth={STROKE_WIDTH}
                pointerEvents="none"
              />
              {/* The rotate handle's pointer target, added for the same reason the
                  resize handles have one: the visible circle is ~11px across, so
                  before this the single hardest gesture in the editor had less than
                  half the target size (WCAG 2.2 AA 2.5.8, 24px) that the eight
                  easier ones were given. Drawn last so it wins the hit test. */}
              <circle
                cx={box.x + box.width / 2}
                cy={rotateCy}
                r={HANDLE_HIT / 2}
                fill="rgba(0,0,0,0)"
                style={{ cursor: "grab", pointerEvents: "all" }}
                aria-label={`rotate handle (${side} the selection)`}
                role="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onHandlePointerDown("rotate", e);
                }}
              />
            </g>
          ) : null}
        </g>
        );
      })() : null}

      {/* Marquee — haloed for the same reason as the frame: a 1px dashed violet
          rectangle dragged across a dark page is invisible. */}
      {marquee ? (
        <g>
          <rect
            x={marquee.x * viewport.zoom + origin.x}
            y={marquee.y * viewport.zoom + origin.y}
            width={marquee.width * viewport.zoom}
            height={marquee.height * viewport.zoom}
            fill={DRAFT_TINT}
            stroke={HALO}
            strokeWidth={3}
          />
          <rect
            x={marquee.x * viewport.zoom + origin.x}
            y={marquee.y * viewport.zoom + origin.y}
            width={marquee.width * viewport.zoom}
            height={marquee.height * viewport.zoom}
            fill="none"
            stroke={ACCENT}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        </g>
      ) : null}

      {/* Snap guides — full-width/height lines through the snap coordinate. */}
      {snapGuides.map((g, i) =>
        g.x !== undefined ? (
          <line
            key={`gx${i}`}
            x1={g.x * viewport.zoom + origin.x}
            y1={0}
            x2={g.x * viewport.zoom + origin.x}
            y2={10000}
            stroke="#DB2777"
            strokeWidth={1}
          />
        ) : g.y !== undefined ? (
          <line
            key={`gy${i}`}
            x1={0}
            y1={g.y * viewport.zoom + origin.y}
            x2={10000}
            y2={g.y * viewport.zoom + origin.y}
            stroke="#DB2777"
            strokeWidth={1}
          />
        ) : null,
      )}
    </g>
  );
}
