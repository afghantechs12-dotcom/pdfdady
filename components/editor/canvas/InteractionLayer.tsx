"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DrawingObject, EditorObject } from "@/src/domain/editor/objects";
import { objectToSvgMatrix, type Viewport, type PageScreenOrigin } from "@/src/application/editor/coordinates/CoordinateSpace";
import { ObjectRenderer } from "./ObjectRenderer";

export interface InteractionLayerHandle {
  ink: (replacements: ReadonlyMap<string, DrawingObject[]>) => void;
  shape: (object: EditorObject | null) => void;
  reset: () => void;
}

/** Only this layer repaints ephemeral drafts; canonical scene subscribers stay idle. */
export const InteractionLayer = forwardRef<InteractionLayerHandle, {
  objects: EditorObject[];
  viewport: Viewport;
  origin: PageScreenOrigin;
  selecting: boolean;
  onObjectPointerDown: (event: React.PointerEvent, object: EditorObject) => void;
}>(function InteractionLayer({ objects, viewport, origin, selecting, onObjectPointerDown }, ref) {
  const [ink, setInk] = useState<ReadonlyMap<string, DrawingObject[]>>(new Map());
  const [shape, setShape] = useState<EditorObject | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ ink?: ReadonlyMap<string, DrawingObject[]>; shape?: EditorObject | null }>({});
  const schedule = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current.ink) setInk(pending.current.ink);
      if ("shape" in pending.current) setShape(pending.current.shape ?? null);
      pending.current = {};
    });
  };
  useImperativeHandle(ref, () => ({
    ink: replacements => { pending.current.ink = new Map(replacements); schedule(); },
    shape: object => { pending.current.shape = object; schedule(); },
    reset: () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = {};
      setInk(new Map());
      setShape(null);
    },
  }));
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return <>
    {objects.flatMap(o => ink.get(o.id) ?? [o]).map(obj => <g key={obj.id}
      transform={objectToSvgMatrix(obj, viewport, origin)} opacity={obj.visible ? 1 : 0}
      style={{ pointerEvents: obj.visible && !obj.locked && selecting ? "auto" : "none", cursor: selecting ? "move" : "crosshair" }}
      onPointerDown={e => onObjectPointerDown(e, obj)} data-object-id={obj.id} role="img" aria-label={obj.name}>
      <rect x={obj.localBounds.x} y={obj.localBounds.y} width={obj.localBounds.width} height={obj.localBounds.height} fill="transparent" pointerEvents={selecting ? "all" : "none"} />
      <ObjectRenderer obj={obj} />
    </g>)}
    {shape && <ShapeDraft object={shape} viewport={viewport} origin={origin} />}
  </>;
});

export function ShapeDraft({ object, viewport, origin }: { object: EditorObject; viewport: Viewport; origin: PageScreenOrigin }) {
  return <g data-shape-draft="true" pointerEvents="none" aria-hidden="true">
    <g transform={objectToSvgMatrix(object, viewport, origin)}><ObjectRenderer obj={object} /></g>
    <text x={object.transform.e * viewport.zoom + origin.x} y={object.transform.f * viewport.zoom + origin.y - 8}
      className="fill-editor-text" fontSize={13}>
      {Math.round(object.localBounds.width)} × {Math.round(object.localBounds.height)}
    </text>
  </g>;
}
