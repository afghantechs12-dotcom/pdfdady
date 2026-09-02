"use client";

import { useId, useRef } from "react";
import type { Bounds, Point } from "@/src/domain/editor/geometry";
import { invert, transformPoint } from "@/src/domain/editor/geometry";
import type { ImageObject } from "@/src/domain/editor/objects";
import {
  objectToSvgMatrix,
  type PageScreenOrigin,
  type Viewport,
} from "@/src/application/editor/coordinates/CoordinateSpace";
import {
  CROP_HANDLES,
  adjustCrop,
  cropRectToLocal,
  fullCrop,
  handleAnchor,
  moveCrop,
  sanitizeCrop,
  type CropHandle,
} from "@/src/application/editor/tools/cropMath";
import { safeImageDataUrl } from "@/src/application/editor/imageValidation";
import { DRAFT } from "@/components/editor/canvas/signalColors";

/**
 * The interactive crop overlay (M6.11). Rendered inside the canvas's page
 * surface group while crop mode is active for one selected image.
 *
 * Model: the object's local box displays the PERSISTED crop; the overlay
 * ghosts the full image behind it (offset by the shared cropDrawSpec math),
 * shows the live DRAFT window at full opacity, and lets eight handles + an
 * interior drag adjust it in NATURAL pixel coordinates (the same units as
 * `ImageObject.crop`, so the numeric inspector and the export path agree).
 * All clamping runs through the pure `cropMath` module. Commit/cancel are
 * owned by the canvas (Enter/Escape/buttons) — this component only edits the
 * draft.
 */
export interface CropOverlayProps {
  obj: ImageObject;
  /** The live draft crop in natural px (already sanitized). */
  draft: Bounds;
  viewport: Viewport;
  origin: PageScreenOrigin;
  /** Client → unrotated page coordinates (the canvas's converter). */
  toPage: (e: { clientX: number; clientY: number }) => Point;
  onDraftChange: (next: Bounds) => void;
}

/** Screen-px hit size for crop handles (WCAG 2.2 target-size ≥ 24). */
const HANDLE_HIT = 24;
/** Screen-px visible size of the handle squares. */
const HANDLE_VISIBLE = 10;

/** Accessible names for the eight handles (SVG <title>). */
const HANDLE_NAMES: Record<CropHandle, string> = {
  nw: "Top-left",
  n: "Top",
  ne: "Top-right",
  e: "Right",
  se: "Bottom-right",
  s: "Bottom",
  sw: "Bottom-left",
  w: "Left",
};

export function CropOverlay({ obj, draft, viewport, origin, toPage, onDraftChange }: CropOverlayProps) {
  const dragRef = useRef<{
    pointerId: number;
    handle: CropHandle | "move";
    startPage: Point;
    startCrop: Bounds;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<Bounds | null>(null);
  const src = safeImageDataUrl(obj.src);

  // The persisted crop defines the local frame (it fills the local box).
  const base = sanitizeCrop(obj.crop ?? fullCrop(obj.naturalWidth, obj.naturalHeight), obj.naturalWidth, obj.naturalHeight);
  const W = obj.localBounds.width;
  const H = obj.localBounds.height;
  const kx = W / base.width; // natural px → local units
  const ky = H / base.height;

  // Full image placement in the local frame (ghost layer).
  const fullOffset = { x: -base.x * kx, y: -base.y * ky };
  const fullW = obj.naturalWidth * kx;
  const fullH = obj.naturalHeight * ky;

  // The draft window in local units.
  const win = cropRectToLocal(draft, base, W, H);

  // Page-space delta between two pointer positions, expressed in NATURAL px.
  // Crop eligibility guarantees invertibility; compute the inverse once per
  // render rather than once per pointer frame.
  const inverseTransform = invert(obj.transform);
  const naturalDelta = (from: Point, to: Point): { dx: number; dy: number } => {
    const a = transformPoint(inverseTransform, from);
    const b = transformPoint(inverseTransform, to);
    return { dx: (b.x - a.x) / kx, dy: (b.y - a.y) / ky };
  };

  const flushDraft = () => {
    rafRef.current = null;
    const next = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (next) onDraftChange(next);
  };
  const queueDraft = (next: Bounds) => {
    pendingDraftRef.current = next;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushDraft);
  };

  const startDrag = (handle: CropHandle | "move") => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, handle, startPage: toPage(e), startCrop: draft };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const { dx, dy } = naturalDelta(drag.startPage, toPage(e));
    const next =
      drag.handle === "move"
        ? moveCrop(drag.startCrop, dx, dy, obj.naturalWidth, obj.naturalHeight)
        : adjustCrop(drag.startCrop, drag.handle, dx, dy, obj.naturalWidth, obj.naturalHeight);
    queueDraft(next);
  };

  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      flushDraft();
    }
    dragRef.current = null;
  };

  // Interrupted gestures (pointercancel, capture stolen by the browser, tab
  // switch) must clear the drag too — otherwise the next pointermove would
  // resume a stale gesture with an old start point.
  const abortDrag = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pendingDraftRef.current = null;
    dragRef.current = null;
  };

  const objectMatrix = objectToSvgMatrix(obj, viewport, origin);
  // useId, not obj.id: two editor surfaces (or two pages) showing the same
  // object id must not collide on a document-global SVG clipPath id.
  const reactId = useId();
  const clipId = `crop-draft-${reactId}`;

  // Handle positions in local units on the draft window.
  const handlePoint = (h: CropHandle): Point => {
    const { fx, fy } = handleAnchor(h);
    return { x: win.x + fx * win.width, y: win.y + fy * win.height };
  };
  // Handle sizes are specified in screen px; divide out zoom AND the object's
  // local→page scale so they render constant-size on screen.
  const sx = Math.abs(Math.hypot(obj.transform.a, obj.transform.b)) || 1;
  const sy = Math.abs(Math.hypot(obj.transform.c, obj.transform.d)) || 1;
  const hitW = HANDLE_HIT / (viewport.zoom * sx);
  const hitH = HANDLE_HIT / (viewport.zoom * sy);
  const visW = HANDLE_VISIBLE / (viewport.zoom * sx);
  const visH = HANDLE_VISIBLE / (viewport.zoom * sy);
  const hairW = 1.5 / (viewport.zoom * sx);

  if (!src) return null;
  return (
    <g
      transform={objectMatrix}
      role="group"
      aria-label="Crop editor. Drag the handles or the window; arrow keys move the window (Shift for 10 px); Enter applies; Escape cancels. Exact values are editable in the Properties panel."
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={win.x} y={win.y} width={win.width} height={win.height} />
        </clipPath>
      </defs>

      {/* Ghost: the full image, dimmed. */}
      <image
        href={src}
        x={fullOffset.x}
        y={fullOffset.y}
        width={fullW}
        height={fullH}
        preserveAspectRatio="none"
        opacity={0.3}
        pointerEvents="none"
      />
      {/* The draft window at full opacity (live preview of the result). */}
      <g clipPath={`url(#${clipId})`}>
        <image
          href={src}
          x={fullOffset.x}
          y={fullOffset.y}
          width={fullW}
          height={fullH}
          preserveAspectRatio="none"
          pointerEvents="none"
        />
      </g>

      {/* Window outline + interior move surface. */}
      <rect
        x={win.x}
        y={win.y}
        width={win.width}
        height={win.height}
        fill="rgba(0,0,0,0)"
        stroke={DRAFT}
        strokeWidth={hairW}
        style={{ cursor: "move", touchAction: "none" }}
        pointerEvents="all"
        onPointerDown={startDrag("move")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={abortDrag}
      />

      {/* Eight handles (24px screen hit targets, WCAG 2.2). */}
      {CROP_HANDLES.map((h) => {
        const p = handlePoint(h);
        return (
          <g key={h}>
            <rect
              x={p.x - visW / 2}
              y={p.y - visH / 2}
              width={visW}
              height={visH}
              fill="#ffffff"
              stroke={DRAFT}
              strokeWidth={hairW}
              pointerEvents="none"
            />
            <rect
              x={p.x - hitW / 2}
              y={p.y - hitH / 2}
              width={hitW}
              height={hitH}
              fill="rgba(0,0,0,0)"
              pointerEvents="all"
              style={{ cursor: cursorFor(h), touchAction: "none" }}
              onPointerDown={startDrag(h)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={abortDrag}
            >
              <title>{HANDLE_NAMES[h]} crop handle</title>
            </rect>
          </g>
        );
      })}
    </g>
  );
}

function cursorFor(h: CropHandle): string {
  switch (h) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
  }
}
