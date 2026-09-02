"use client";

import { memo } from "react";
import { editorColorToCss } from "@/lib/editor/color";
import { resolveFont, familyIsItalic } from "@/lib/editor/fontSubstitution";
import { base14Ascent } from "@/src/domain/editor/textMetrics";
import type {
  AnnotationObject,
  DrawingObject,
  EditorObject,
  HighlightObject,
  ImageObject,
  ShapeObject,
  SignatureObject,
  TextObject,
} from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { shouldDrawTextObject } from "@/src/domain/editor/importedTextRendering";
import { shapePathData, shapeIsClosed } from "@/src/domain/editor/shapeGeometry";
import { annotationPanel, annotationTextLayout } from "@/src/domain/editor/annotationLayout";
import { deriveDrawingRender } from "@/src/application/editor/tools/drawingGeometry";
import { cropDrawSpec } from "@/src/application/editor/tools/cropMath";
import { safeImageDataUrl } from "@/src/application/editor/imageValidation";
import { fitContain } from "@/src/domain/editor/geometry";

/**
 * Renders the INNER SVG content for one editor object (no transform — the
 * caller wraps this in a `<g transform="matrix(a,b,c,d,e,f)">` computed from the
 * object's {@link AffineTransform} + the viewport). Each kind maps to its SVG
 * primitives; {@link EditorColor} → CSS via `editorColorToCss`, and requested
 * fonts resolve to a PDF base-14 family (with substitution noted for the
 * inspector, but rendered as-is on screen).
 *
 * The component is pure + memoized: it only depends on the object, so it skips
 * re-render when an unrelated object changes (the canvas maps over objects and
 * React reconciles per-id).
 */
function ObjectRendererInner({ obj }: { obj: EditorObject }) {
  // `isObjectKind` narrows out PluginEditorObject (whose kind is `string`),
  // which a plain switch can't do because `string` matches every literal case.
  if (isObjectKind(obj, "text")) return <TextContent obj={obj} />;
  if (isObjectKind(obj, "image")) return <ImageContent obj={obj} />;
  if (isObjectKind(obj, "shape")) return <ShapeContent obj={obj} />;
  if (isObjectKind(obj, "highlight")) return <HighlightContent obj={obj} />;
  if (isObjectKind(obj, "drawing")) return <DrawingContent obj={obj} />;
  if (isObjectKind(obj, "annotation")) return <AnnotationContent obj={obj} />;
  if (isObjectKind(obj, "signature")) return <SignatureContent obj={obj} />;
  // Plugin-defined kinds have no built-in renderer; show a labeled placeholder
  // box so the object is visible + selectable (a plugin can replace this).
  return <PluginPlaceholder obj={obj} />;
}

/** A visible placeholder for plugin objects the core doesn't know how to draw. */
function PluginPlaceholder({ obj }: { obj: EditorObject }) {
  const w = obj.localBounds.width;
  const h = obj.localBounds.height;
  return (
    <g>
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill="rgba(124,58,237,0.08)"
        stroke="rgba(124,58,237,0.5)"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <text
        x={w / 2}
        y={h / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Helvetica, sans-serif"
        fontSize={Math.min(14, h / 3)}
        fill="rgba(124,58,237,0.9)"
      >
        {obj.kind}
      </text>
    </g>
  );
}

function TextContent({ obj }: { obj: TextObject }) {
  const { text, fontSize, fontFamily, fontWeight, color, align, lineHeight, letterSpacing, localBounds, opacity, background, sourceText } = obj;
  const resolved = resolveFont(fontFamily);
  const anchor = align === "left" ? "start" : align === "center" ? "middle" : "end";
  const x = align === "left" ? 0 : align === "center" ? localBounds.width / 2 : localBounds.width;
  const lines = text.split("\n");
  const dy = fontSize * (lineHeight || 1.2);
  const isSourceText = sourceText != null;
  // A READONLY imported run draws NOTHING. The original text is already visible
  // in the page raster underneath; drawing a re-typeset copy on top of it is
  // exactly the duplication defect this replaced. An invisible hit rect keeps
  // the run selectable (SVG needs a painted target, so `fill="none"` would not
  // receive pointer events — a transparent fill does).
  //
  // The decision comes from the SHARED predicate the exporter also uses, so the
  // canvas and the exported PDF cannot disagree about what is visible. It does
  // not depend on selection or edit state, so a run cannot become a second copy
  // while it happens to be selected.
  if (!shouldDrawTextObject(obj)) {
    return (
      <rect
        x={0}
        y={0}
        width={localBounds.width}
        height={localBounds.height}
        fill="transparent"
        pointerEvents="all"
      />
    );
  }
  // A REPLACEMENT run renders its text over an independently-probed background
  // fill that permanently removes the original. The fill stays fully opaque
  // regardless of the object's opacity — a semi-transparent removal would leak
  // the original text through, which is the same duplication in a subtler form.
  const coverOpacity = isSourceText ? 1 : opacity;
  // Imported runs place the baseline EXACTLY on the original via the transform
  // `T(baseline)·R(θ)·T(0, −ascent)`, where `ascent` is the mapped base-14
  // ascender. The first baseline therefore sits at local y = `ascent`, so anchor
  // with `alphabetic` + y = ascent (the SAME value the transform and the
  // exporter use, via `textMetrics`). Editor-authored text has no `T(0, −ascent)`
  // shift in its transform, so it keeps the top-anchored `hanging` + y = 0
  // convention M4 used (unchanged, no regression).
  const textY = isSourceText ? base14Ascent(resolved.family, fontSize) : 0;
  const baseline = isSourceText ? "alphabetic" : "hanging";
  return (
    <g>
      {/* An opaque text-frame background — for a replacement run this is the
          probed page color that permanently removes the original glyphs. Drawn
          at the local box so it rotates with the text and covers the glyph run
          (ascender + descender) for any rotation. Drawn before the text so the
          text sits on top. */}
      {background ? (
        <rect
          x={0}
          y={0}
          width={localBounds.width}
          height={localBounds.height}
          fill={editorColorToCss(background)}
          opacity={coverOpacity}
        />
      ) : null}
      <text
        x={x}
        y={textY}
        fill={editorColorToCss(color)}
        fontFamily={resolved.family}
        fontSize={fontSize}
        fontWeight={fontWeight}
        // Posture lives in the FAMILY for base-14 ("Helvetica-Oblique",
        // "Times-Italic"), and the browser cannot infer a slant from a
        // PostScript name it does not have installed. Without this the canvas
        // rendered upright while the PDF exported slanted — the same run looked
        // different on screen and on paper. `familyIsItalic` is the same
        // predicate the exporter uses, so the two cannot drift.
        fontStyle={familyIsItalic(resolved.family) ? "italic" : undefined}
        opacity={opacity}
        textAnchor={anchor}
        dominantBaseline={baseline}
        letterSpacing={letterSpacing ? `${letterSpacing}px` : undefined}
        style={{ whiteSpace: "pre" }}
      >
        {lines.map((line, i) => (
          <tspan key={i} x={x} dy={i === 0 ? 0 : dy}>
            {line || " "}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function ImageContent({ obj }: { obj: ImageObject }) {
  const src = safeImageDataUrl(obj.src);
  if (!src) return <InvalidImagePlaceholder width={obj.localBounds.width} height={obj.localBounds.height} />;
  const spec = cropDrawSpec(obj);
  if (spec) {
    const clipId = `crop-${obj.id}`;
    return (
      <g clipPath={`url(#${clipId})`} opacity={obj.opacity}>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={obj.localBounds.width} height={obj.localBounds.height} />
        </clipPath>
        <image
          href={src}
          x={spec.offset.x}
          y={spec.offset.y}
          width={spec.width}
          height={spec.height}
          preserveAspectRatio="none"
        />
      </g>
    );
  }
  return (
    <image
      href={src}
      x={0}
      y={0}
      width={obj.localBounds.width}
      height={obj.localBounds.height}
      opacity={obj.opacity}
      preserveAspectRatio="none"
    />
  );
}

function InvalidImagePlaceholder({ width, height }: { width: number; height: number }) {
  return (
    <g aria-label="Invalid image source">
      <rect width={width} height={height} fill="#f8fafc" stroke="#ef4444" strokeDasharray="4 3" />
      <line x1={0} y1={0} x2={width} y2={height} stroke="#ef4444" />
      <line x1={width} y1={0} x2={0} y2={height} stroke="#ef4444" />
    </g>
  );
}

/**
 * Renders any {@link ShapeKind} from the CANONICAL geometry module: one
 * `<path d={shapePathData(obj)}>` — the exact path data the PDF exporter hands
 * pdf-lib, so screen and export agree by construction. Open kinds (line,
 * connector, bezier/path, open-head arrows) render stroke-only; stroke-only
 * kinds with no stroke fall back to a visible 1px black stroke (the pre-M6
 * line behavior, so a stroke-less line is never invisible). The optional
 * `dash` maps to `strokeDasharray`; the optional `shadow` becomes a per-object
 * `feDropShadow` filter (ids are namespaced by object id, like image crops).
 */
function ShapeContent({ obj }: { obj: ShapeObject }) {
  const { style, opacity } = obj;
  const closed = shapeIsClosed(obj);
  const strokeOnly = !closed;
  const fill = closed && style.fill ? editorColorToCss(style.fill) : "none";
  let stroke = style.stroke ? editorColorToCss(style.stroke) : "none";
  let strokeWidth = style.strokeWidth;
  if (strokeOnly && stroke === "none") {
    stroke = "#000";
    strokeWidth = strokeWidth || 1;
  }
  const d = shapePathData(obj);
  const dash = style.dash && style.dash.length > 0 ? style.dash.join(" ") : undefined;
  const shadow = style.shadow ?? null;
  const filterId = `shape-shadow-${obj.id}`;
  const path = (
    <path
      d={d}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={opacity}
    />
  );
  if (!shadow) return path;
  return (
    <g>
      <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow
          dx={shadow.offsetX}
          dy={shadow.offsetY}
          stdDeviation={shadow.blur / 2}
          floodColor={editorColorToCss({ ...shadow.color, a: 1 })}
          floodOpacity={shadow.color.a}
        />
      </filter>
      <g filter={`url(#${filterId})`}>{path}</g>
    </g>
  );
}

function HighlightContent({ obj }: { obj: HighlightObject }) {
  const { color, localBounds, opacity } = obj;
  return (
    <rect
      x={0}
      y={0}
      width={localBounds.width}
      height={localBounds.height}
      fill={editorColorToCss(color)}
      opacity={color.a * opacity}
      style={{ mixBlendMode: "multiply" }}
    />
  );
}

/**
 * Renders a freehand stroke from the shared {@link deriveDrawingRender}
 * derivation (M6): pressure strokes become a filled variable-width outline,
 * constant strokes a (possibly smoothed) path; marker/highlighter carry a
 * brush opacity factor and highlighter multiplies (like HighlightObject); the
 * pencil's jitter texture is deterministic. The exporter consumes the SAME
 * spec, so screen and PDF agree by construction.
 */
function DrawingContent({ obj }: { obj: DrawingObject }) {
  const { points, style, opacity } = obj;
  if (points.length === 0) return null;
  const stroke = style.stroke ? editorColorToCss(style.stroke) : "#000";
  const spec = deriveDrawingRender(obj);
  const effOpacity = opacity * spec.opacityFactor;
  const blend = spec.blendMultiply ? ({ mixBlendMode: "multiply" } as const) : undefined;
  if (spec.mode === "fill") {
    return <path d={spec.pathData} fill={stroke} stroke="none" opacity={effOpacity} style={blend} />;
  }
  return (
    <path
      d={spec.pathData}
      fill="none"
      stroke={stroke}
      strokeWidth={spec.strokeWidth}
      opacity={effOpacity}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={blend}
    />
  );
}

/**
 * A sticky note: its panel, its text, and an optional pointer arrow.
 *
 * The panel's fill, border and radius come from the OBJECT, not from this file.
 * They used to be literals here (`fill="rgba(255,245,180,0.95)"`), which meant
 * the yellow every user saw was never saved and never exported — the note
 * survived a round trip as bare text. {@link annotationPanel} is now the single
 * source both this renderer and the PDF exporter read.
 */
function AnnotationContent({ obj }: { obj: AnnotationObject }) {
  const { fontSize, color, pointerTarget, localBounds, opacity } = obj;
  const fill = editorColorToCss(color);
  const panel = annotationPanel(obj);
  const layout = annotationTextLayout(obj);
  return (
    <g opacity={opacity}>
      {panel ? (
        <path
          d={panel.pathData}
          fill={panel.background ? editorColorToCss(panel.background) : "none"}
          stroke={panel.border ? editorColorToCss(panel.border) : "none"}
          strokeWidth={panel.borderWidth}
        />
      ) : null}
      <text
        x={layout.x}
        y={0}
        fill={fill}
        fontFamily="Helvetica, sans-serif"
        fontSize={fontSize}
        dominantBaseline="hanging"
        style={{ whiteSpace: "pre" }}
      >
        {layout.lines.map((line, i) => (
          <tspan key={i} x={layout.x} dy={i === 0 ? layout.firstLineTop : layout.lineAdvance}>
            {line || " "}
          </tspan>
        ))}
      </text>
      {pointerTarget ? (
        <line
          x1={localBounds.width / 2}
          y1={localBounds.height}
          x2={pointerTarget.x}
          y2={pointerTarget.y}
          stroke={fill}
          strokeWidth={1}
          markerEnd="url(#annotation-arrow)"
        />
      ) : null}
    </g>
  );
}

function SignatureContent({ obj }: { obj: SignatureObject }) {
  const { localBounds, opacity } = obj;
  const src = safeImageDataUrl(obj.src);
  if (!src) return <InvalidImagePlaceholder width={localBounds.width} height={localBounds.height} />;
  // A signature is letterboxed inside its box, never stretched — distorting
  // someone's signature misrepresents it.
  //
  // The rect is computed by the shared `fitContain` helper rather than left to
  // `preserveAspectRatio`, for two reasons: the previous value here was
  // `"contain"`, which is a CSS object-fit keyword and NOT a legal SVG
  // preserveAspectRatio value (browsers silently fell back to the default
  // `xMidYMid meet`); and the exporter has no preserveAspectRatio to lean on,
  // so the only way preview and export cannot drift is to share the geometry.
  // The exporter calls the same helper. See `fitContain` in domain/geometry.
  const fitted = fitContain(obj.naturalWidth, obj.naturalHeight, localBounds);
  return (
    <g opacity={opacity}>
      <image
        href={src}
        x={fitted.x}
        y={fitted.y}
        width={fitted.width}
        height={fitted.height}
        preserveAspectRatio="none"
      />
    </g>
  );
}

export const ObjectRenderer = memo(ObjectRendererInner, (prev, next) => prev.obj === next.obj);

export { isObjectKind };
