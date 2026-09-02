"use client";

import { useMemo } from "react";
import { SmartRulerEngine } from "@/src/application/editor/extensions/RulerEngine";
import type { PageScreenOrigin, Viewport } from "@/src/application/editor/coordinates/CoordinateSpace";

/**
 * Ruler bars (Part 4) drawn above + left of the page, using the
 * {@link SmartRulerEngine} for "nice" tick intervals that adapt to zoom. The
 * rulers span the page (positioned with it via `origin`/`zoom`) so ticks align
 * exactly with page coordinates.
 */
export function Rulers({ viewport, origin, pageSize }: { viewport: Viewport; origin: PageScreenOrigin; pageSize: { width: number; height: number } }) {
  const engine = useMemo(() => new SmartRulerEngine({ pixelsPerUnit: viewport.zoom }), [viewport.zoom]);
  const hTicks = engine.ticksFor(0, pageSize.width, "horizontal");
  const vTicks = engine.ticksFor(0, pageSize.height, "vertical");
  const RULE = 18;
  const w = pageSize.width * viewport.zoom;
  const h = pageSize.height * viewport.zoom;

  return (
    <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
      {/* Corner */}
      <div className="absolute bg-slate-50" style={{ left: 0, top: 0, width: RULE, height: RULE }} />
      {/* Horizontal ruler */}
      <svg className="absolute" style={{ left: origin.x, top: 0, width: w, height: RULE }} viewBox={`0 0 ${w} ${RULE}`}>
        <rect x={0} y={0} width={w} height={RULE} fill="#f8fafc" stroke="#e2e8f0" strokeWidth={1} />
        {hTicks.map((t, i) => {
          const x = t.position * viewport.zoom;
          return (
            <g key={i}>
              <line x1={x} y1={t.major ? RULE - 9 : RULE - 5} x2={x} y2={RULE} stroke="#94a3b8" strokeWidth={1} />
              {t.major && t.label ? (
                <text x={x + 2} y={9} fontSize={9} fill="#64748b" fontFamily="ui-sans-serif, system-ui">
                  {t.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* Vertical ruler */}
      <svg className="absolute" style={{ left: 0, top: origin.y, width: RULE, height: h }} viewBox={`0 0 ${RULE} ${h}`}>
        <rect x={0} y={0} width={RULE} height={h} fill="#f8fafc" stroke="#e2e8f0" strokeWidth={1} />
        {vTicks.map((t, i) => {
          const y = t.position * viewport.zoom;
          return (
            <g key={i}>
              <line x1={t.major ? RULE - 9 : RULE - 5} y1={y} x2={RULE} y2={y} stroke="#94a3b8" strokeWidth={1} />
              {t.major && t.label ? (
                <text x={2} y={y + 9} fontSize={9} fill="#64748b" fontFamily="ui-sans-serif, system-ui">
                  {t.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
