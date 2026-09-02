"use client";

import { useRef, useState } from "react";
import {
  AlignCenter as AlignCenterIcon,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  FlipHorizontal,
  FlipVertical,
  Highlighter,
  Info,
  Lock,
  MessageSquare,
  MoveHorizontal,
  MoveVertical,
  Replace,
  RotateCw,
  Trash2,
  Unlock,
} from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import {
  ColorField,
  ControlRow,
  FieldGroup,
  InspectorSection,
  NumberField,
  NumberPairRow,
  SecondaryButton,
  SegmentedControl,
  SelectField,
  Slider,
} from "@/components/editor/InspectorControls";
import {
  availableFonts,
  familyIsItalic,
  italicSupport,
  resolveFont,
  withItalic,
} from "@/lib/editor/fontSubstitution";
import { decompose, type AffineTransform } from "@/src/domain/editor/geometry";
import { worldBounds } from "@/src/domain/editor/document";
import {
  MAX_INNER_RATIO,
  MAX_POLYGON_SIDES,
  MAX_STAR_POINTS,
  MIN_INNER_RATIO,
  MIN_POLYGON_SIDES,
  MIN_STAR_POINTS,
  clampHeadSize,
  clampInnerRatio,
  clampSides,
  clampStarPoints,
  clampTailPosition,
} from "@/src/domain/editor/shapeGeometry";
import { fullCrop, resolveCropCommit } from "@/src/application/editor/tools/cropMath";
import { decodeImageDimensions, readImageFileAsDataUrl } from "@/src/application/editor/imageValidation";
import {
  dashForPreset,
  dashPresetOf,
  inspectorHeading,
  lockedSize,
  pageSizeLabel,
  positionDelta,
  representativeValue,
  rotationDegOf,
  rotationDelta,
  type DashPresetId,
} from "@/components/editor/panels/propertiesPanelLogic";
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
import { isReadonlySourceText } from "@/src/domain/editor/importedTextRendering";
import { resolveSelectionAffordance } from "@/components/editor/canvas/selectionAffordances";

/**
 * The Properties inspector (Part 7). Renders controls for the primary selected
 * object's kind, or alignment/distribution controls for a multi-selection, or
 * page info when nothing is selected. Every control commits through the facade
 * (a `setProperty` for scalar fields, `setObjectSize`/`flipSelection` for
 * transforms, `alignSelection`/`distributeSelection` for multi-selection).
 */
export function PropertiesPanel() {
  const { state, service, activePage, selection, actions } = useEditorContext();
  const primary = selection.primaryId ? activePage.objects[selection.primaryId] : undefined;

  if (selection.objects.length === 0) {
    const pages = state.document.pages;
    const pageIndex = pages.findIndex((page) => page.id === activePage.id);
    return (
      <div className="flex h-full flex-col">
        {/* "Page", not "Properties": the tab already says Properties, and what
            the panel is describing with no selection is the page (H3/H41). */}
        <PanelHeader title={inspectorHeading({ count: 0, kind: null })} />
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <InspectorSection title="Page">
            {/* One readout rather than two disabled number inputs. The page size
                is not editable here, and a disabled field that can never become
                enabled reads as a broken control. */}
            <ControlRow label="Size">
              <span className="min-w-0 flex-1 truncate text-xs text-editor-text">
                {pageSizeLabel(activePage.width, activePage.height)}
              </span>
            </ControlRow>
            <ControlRow label="Rotation">
              <span className="min-w-0 flex-1 truncate text-xs text-editor-text">
                {activePage.rotation}°
              </span>
            </ControlRow>
            {/* Every one of these is a real, undoable facade command — the same
                ones the Pages panel uses. Nothing here is a placeholder. */}
            <div className="grid grid-cols-3 gap-1 pt-0.5">
              <SecondaryButton
                title="Rotate this page 90° clockwise"
                onClick={() => service.rotatePageBy(activePage.id, 90)}
              >
                <RotateCw className="h-3.5 w-3.5" />
                Rotate
              </SecondaryButton>
              <SecondaryButton
                title="Duplicate this page"
                onClick={() => service.duplicatePage(activePage.id)}
              >
                <Copy className="h-3.5 w-3.5" />
                Duplicate
              </SecondaryButton>
              <SecondaryButton
                title={
                  pages.length > 1
                    ? "Delete this page"
                    : "A document must keep at least one page."
                }
                disabled={pages.length <= 1}
                onClick={() => service.deletePage(activePage.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </SecondaryButton>
            </div>
          </InspectorSection>
          <InspectorSection title="Document">
            <ControlRow label="Pages">
              <span className="min-w-0 flex-1 truncate text-xs text-editor-text">
                {pages.length}
              </span>
            </ControlRow>
            {pageIndex >= 0 ? (
              <ControlRow label="Current">
                <span className="min-w-0 flex-1 truncate text-xs text-editor-text">
                  {pageIndex + 1} of {pages.length}
                </span>
              </ControlRow>
            ) : null}
          </InspectorSection>
          <p className="px-3 pb-3 text-xs text-editor-muted">
            Select an object to edit its properties.
          </p>
        </div>
      </div>
    );
  }

  if (selection.objects.length > 1) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader
          title={inspectorHeading({
            count: selection.objects.length,
            // The primary's kind is irrelevant to a multi-selection heading, but
            // it must be a real value rather than a sentinel: `count > 1` is what
            // decides this heading, and passing a fake kind would make the
            // helper's contract look narrower than it is.
            kind: primary?.kind ?? null,
          })}
        />
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <FieldGroup title="Align">
            <div className="grid grid-cols-6 gap-1">
              <AlignButton title="Align left" onClick={() => actions.alignSelection("left")}><AlignStartVertical className="h-4 w-4" /></AlignButton>
              <AlignButton title="Align center horizontal" onClick={() => actions.alignSelection("centerX")}><AlignCenterVertical className="h-4 w-4" /></AlignButton>
              <AlignButton title="Align right" onClick={() => actions.alignSelection("right")}><AlignEndVertical className="h-4 w-4" /></AlignButton>
              <AlignButton title="Align top" onClick={() => actions.alignSelection("top")}><AlignStartHorizontal className="h-4 w-4" /></AlignButton>
              <AlignButton title="Align center vertical" onClick={() => actions.alignSelection("centerY")}><AlignCenterHorizontal className="h-4 w-4" /></AlignButton>
              <AlignButton title="Align bottom" onClick={() => actions.alignSelection("bottom")}><AlignEndHorizontal className="h-4 w-4" /></AlignButton>
            </div>
          </FieldGroup>
          <FieldGroup title="Distribute">
            <div className="grid grid-cols-2 gap-1">
              <AlignButton title="Distribute horizontally" onClick={() => actions.distributeSelection("horizontal")} disabled={selection.objects.length < 3}>
                <MoveHorizontal className="h-4 w-4" /> <span className="ml-1 text-xs">Horizontal</span>
              </AlignButton>
              <AlignButton title="Distribute vertically" onClick={() => actions.distributeSelection("vertical")} disabled={selection.objects.length < 3}>
                <MoveVertical className="h-4 w-4" /> <span className="ml-1 text-xs">Vertical</span>
              </AlignButton>
            </div>
          </FieldGroup>
          <OpacitySection ids={selection.ids} />
        </div>
      </div>
    );
  }

  if (!primary) return null;

  // One verdict, shared with the canvas chrome: what this selection may edit.
  const primaryAffordance = resolveSelectionAffordance([primary]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={inspectorHeading({
          count: 1,
          kind: primary.kind,
          // "Original PDF text", not "Text" — the two support different actions,
          // and the heading is where that difference is first visible.
          readonlySourceText:
            isObjectKind(primary, "text") && isReadonlySourceText(primary),
        })}
      />
      {primary.locked ? (
        <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          This object is locked — properties are read-only. Unlock it (context menu) to edit.
        </div>
      ) : null}
      {/* fieldset[disabled] makes every native control inside read-only for a
          locked object (M6.16) without per-control wiring.

          `min-w-0` is load-bearing: a fieldset carries a browser-default
          `min-inline-size: min-content`, so unlike a div it refuses to shrink
          below its widest content. That is what put a horizontal scrollbar in
          the inspector — one long, unbreakable value (a PDF subset font name)
          set the floor for the whole panel. */}
      <fieldset disabled={primary.locked} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {isObjectKind(primary, "text") ? <TextControls obj={primary} /> : null}
        {isObjectKind(primary, "image") ? <ImageControls obj={primary} /> : null}
        {isObjectKind(primary, "shape") ? <ShapeControls obj={primary} /> : null}
        {isObjectKind(primary, "highlight") ? <HighlightControls obj={primary} /> : null}
        {isObjectKind(primary, "drawing") ? <DrawingControls obj={primary} /> : null}
        {isObjectKind(primary, "annotation") ? <AnnotationControls obj={primary} /> : null}
        {isObjectKind(primary, "signature") ? <SignatureControls obj={primary} /> : null}
        {/* Geometry and appearance are omitted for a read-only imported run: X/Y,
            W/H, rotation, opacity and flip cannot be applied to original PDF
            content, and offering them is the contradiction the affordance model
            removes. TextControls above already explains the run and offers the
            actions that DO work (Copy text). */}
        {primaryAffordance.allowsGeometry ? (
          <>
            <PositionSection obj={primary} />
            <OpacitySection ids={[primary.id]} />
          </>
        ) : null}
      </fieldset>
    </div>
  );
}

function PanelHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-editor-border px-3 py-2">
      <h2 className="truncate text-sm font-semibold text-editor-text">{title}</h2>
    </div>
  );
}

function AlignButton({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="flex items-center justify-center rounded border border-editor-border px-1 py-1 text-editor-muted hover:bg-editor-accentsoft hover:text-editor-accent disabled:opacity-30"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function displayedSize(transform: AffineTransform, localW: number, localH: number): { w: number; h: number } {
  const { scale } = decompose(transform);
  return { w: Math.round(Math.abs(localW * scale.x)), h: Math.round(Math.abs(localH * scale.y)) };
}

function PositionSection({ obj }: { obj: EditorObject }) {
  const { actions } = useEditorContext();
  const { w, h } = displayedSize(obj.transform, obj.localBounds.width, obj.localBounds.height);
  const deg = rotationDegOf(decompose(obj.transform).rotation);
  const bounds = worldBounds(obj);
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  // Session-only panel state, default ON for images: a photo is the case where
  // an accidental stretch is both most likely and most visible. Not persisted —
  // the dock preference is the one thing the editor stores, and a second key
  // invites the two to disagree.
  const [locked, setLocked] = useState(isObjectKind(obj, "image"));

  const rotateTo = (target: number) => {
    if (!Number.isFinite(target)) return;
    const b = worldBounds(obj);
    actions.rotateSelection(
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      rotationDelta(deg, target),
    );
  };

  /** X/Y are absolute; the only move primitive is relative, so convert. */
  const moveTo = (next: { x?: number; y?: number }) => {
    const delta = positionDelta({ x, y }, next);
    if (delta) actions.moveSelection(delta);
  };

  /**
   * Both dimensions go in ONE `setObjectSize` call, so a locked edit stays a
   * single undo entry rather than two chained resizes.
   */
  const sizeTo = (edit: { w?: number; h?: number }) => {
    const next = lockedSize({ w, h }, edit, locked);
    if (next) actions.setObjectSize(obj.id, next.w, next.h);
  };

  return (
    <InspectorSection title="Position & size">
      <NumberPairRow
        first={{ label: "X", name: "X position", value: x, onCommit: (v) => moveTo({ x: v }) }}
        second={{ label: "Y", name: "Y position", value: y, onCommit: (v) => moveTo({ y: v }) }}
        unit="pt"
      />
      <NumberPairRow
        first={{ label: "W", name: "Width", value: w, min: 1, onCommit: (v) => sizeTo({ w: v }) }}
        second={{ label: "H", name: "Height", value: h, min: 1, onCommit: (v) => sizeTo({ h: v }) }}
        unit="pt"
        trailing={
          <button
            type="button"
            aria-pressed={locked}
            aria-label="Lock aspect ratio"
            title={locked ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            onClick={() => setLocked((l) => !l)}
            className={`flex h-8 w-8 items-center justify-center rounded-control border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/40 ${
              locked
                ? "border-editor-accent/40 bg-editor-accentsoft text-editor-accent"
                : "border-editor-border text-editor-muted hover:bg-editor-subtle"
            }`}
          >
            {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          </button>
        }
      />
      <NumberField label="Rotation" value={deg} min={-180} max={180} onCommit={rotateTo} suffix="°" />
    </InspectorSection>
  );
}

function OpacitySection({ ids }: { ids: string[] }) {
  const { activePage, actions } = useEditorContext();
  const objs = ids.map((id) => activePage.objects[id]).filter((o): o is EditorObject => Boolean(o));
  if (objs.length === 0) return null;
  // Representative value + a "Mixed" marker when the selection disagrees.
  const rep = representativeValue(objs.map((o) => Math.round(o.opacity * 100)));
  return (
    <FieldGroup title="Appearance">
      <Slider
        label={rep.mixed ? "Opacity*" : "Opacity"}
        value={rep.value}
        min={0}
        max={100}
        onCommit={(v) => {
          const changed = objs.filter((obj) => Math.round(obj.opacity * 100) !== v);
          if (changed.length === 0) return;
          if (changed.length > 1) actions.beginTransaction("Opacity");
          try {
            changed.forEach((obj) => actions.setProperty(obj.id, { opacity: v / 100 }, "Opacity"));
            if (changed.length > 1) actions.commit();
          } catch (error) {
            if (changed.length > 1) actions.rollback();
            throw error;
          }
        }}
      />
      {rep.mixed ? <p className="text-xs text-editor-muted">* Mixed values — moving the slider applies one value to all.</p> : null}
      <div className="grid min-w-0 grid-cols-2 gap-1 pt-1">
        <SecondaryButton onClick={() => actions.flipSelection("x")} title="Flip horizontal">
          <FlipHorizontal className="h-3.5 w-3.5" /> Flip H
        </SecondaryButton>
        <SecondaryButton onClick={() => actions.flipSelection("y")} title="Flip vertical">
          <FlipVertical className="h-3.5 w-3.5" /> Flip V
        </SecondaryButton>
      </div>
    </FieldGroup>
  );
}

/**
 * One action offered for a read-only source-PDF run. Shared so the three buttons
 * cannot drift in size/focus treatment.
 */
function SourceTextAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex min-h-[28px] items-center gap-1.5 rounded-control border border-editor-border bg-editor-surface px-2 text-[11px] font-semibold text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function TextControls({ obj }: { obj: TextObject }) {
  const { actions } = useEditorContext();
  const resolved = resolveFont(obj.fontFamily);
  const fonts = availableFonts();
  // Bound once so TypeScript keeps the narrowing through the JSX below (reading
  // `obj.sourceText` repeatedly re-widens it to possibly-null on each access).
  const source = obj.sourceText ?? null;
  const isReadonly = isReadonlySourceText(obj);
  return (
    <>
      {source ? (
        <div className="min-w-0 border-b border-editor-border bg-editor-subtle px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-editor-text">
            <Info size={13} aria-hidden="true" className="shrink-0 text-editor-muted" />
            {isReadonly ? "Original PDF text" : "Text replacement"}
          </p>
          {source.fontName ? (
            // A PDF subset font name ("ABCDEF+DejaVuSansCondensed-BoldOblique")
            // is one unbreakable token; without an explicit break it sets a
            // min-content floor wider than the panel.
            <p className="mt-1 break-words text-[11px] leading-relaxed text-editor-muted">
              Source font: {source.fontName}
            </p>
          ) : null}
          {isReadonly ? (
            <>
              <p className="mt-1.5 text-[11px] leading-relaxed text-editor-muted">
                {source.reason || "This text is part of the original PDF content and cannot be edited safely."}
              </p>
              {/* The selected run itself, so the panel is about THIS text rather
                  than a generic explanation. Clamped: a long run must not grow
                  the inspector. */}
              <p
                className="mt-2 line-clamp-3 break-words rounded-control border border-editor-border bg-editor-surface px-2 py-1.5 text-[11px] italic leading-relaxed text-editor-text"
                title={source.originalText ?? obj.text}
              >
                “{source.originalText ?? obj.text}”
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-editor-muted">
                You can select and copy this text. To add new text, use the Text tool.
              </p>
              {/* Only actions that genuinely work. No Redact: this build has no
                  content-destroying redaction, and a button that implies data was
                  removed when it was not is a safety claim we will not fake. */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <SourceTextAction
                  icon={<Copy size={12} aria-hidden="true" />}
                  label="Copy text"
                  onClick={() => {
                    void navigator.clipboard?.writeText(source.originalText ?? obj.text);
                  }}
                />
                <SourceTextAction
                  icon={<Highlighter size={12} aria-hidden="true" />}
                  label="Highlight"
                  onClick={() => {
                    // A real highlight object over the run's own bounds.
                    const b = obj.localBounds;
                    const { x, y } = decompose(obj.transform).translate;
                    actions.addHighlight(
                      { x, y },
                      { localBounds: { ...b, x: 0, y: 0 } },
                    );
                  }}
                />
                <SourceTextAction
                  icon={<MessageSquare size={12} aria-hidden="true" />}
                  label="Comment"
                  onClick={() => {
                    const { x, y } = decompose(obj.transform).translate;
                    actions.addAnnotation(
                      { x: x + obj.localBounds.width + 8, y },
                      { text: source.originalText ?? obj.text },
                    );
                  }}
                />
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-[11px] leading-relaxed text-editor-muted">
              The original text has been permanently removed from the replacement region.
            </p>
          )}
        </div>
      ) : null}
      {/* Typography controls are meaningless for a readonly run: it does not
          render, so changing its font or color would change nothing the user can
          see, while implying the original PDF text is being restyled. */}
      {!isReadonly ? (
      <FieldGroup title="Text">
        <SelectField
          label="Font"
          value={resolved.family}
          options={fonts.map((f) => ({ value: f.family, label: f.label }))}
          onCommit={(family) => actions.setProperty<TextObject>(obj.id, { fontFamily: family }, "Font")}
        />
        {resolved.substituted ? <p className="text-xs text-amber-600">{resolved.reason}</p> : null}
        <NumberField label="Size" value={obj.fontSize} min={1} onCommit={(v) => actions.setProperty<TextObject>(obj.id, { fontSize: v }, "Font size")} suffix="pt" />
        {/* Bold and Italic are INDEPENDENT axes on purpose: bold is `fontWeight`,
            italic is the base-14 family ("Helvetica-Oblique"). The exporter
            derives them separately, so all four permutations map to a real font
            without either toggle clobbering the other.

            No Underline button. `TextDecoration` exists in the type system but
            has zero renderer and zero export support, so a U here would be a
            control that visibly does nothing — omitted rather than faked. */}
        <ControlRow label="Style">
          <SegmentedControl
            label="Text style"
            items={[
              {
                id: "bold",
                label: "Bold",
                text: "B",
                pressed: obj.fontWeight >= 600,
                onPress: () =>
                  actions.setProperty<TextObject>(
                    obj.id,
                    { fontWeight: obj.fontWeight >= 600 ? 400 : 700 },
                    "Bold",
                  ),
              },
              {
                id: "italic",
                label: "Italic",
                text: "I",
                pressed: familyIsItalic(resolved.family),
                // Symbol/ZapfDingbats have no oblique variant in base-14, so the
                // toggle would silently do nothing — disable it with the reason.
                disabled: !italicSupport(resolved.family).supported,
                reason: italicSupport(resolved.family).reason,
                onPress: () =>
                  actions.setProperty<TextObject>(
                    obj.id,
                    { fontFamily: withItalic(resolved.family, !familyIsItalic(resolved.family)) },
                    "Italic",
                  ),
              },
            ]}
          />
        </ControlRow>
        {/* Left/Center/Right only. `align` has no "justify" member in the domain
            (objects.ts), and neither the renderer nor the exporter distributes
            inter-word space, so a Justify button could not do what it says. */}
        <ControlRow label="Align">
          <SegmentedControl
            label="Text alignment"
            items={(
              [
                ["left", "Align left", AlignLeft],
                ["center", "Align center", AlignCenterIcon],
                ["right", "Align right", AlignRight],
              ] as const
            ).map(([value, label, Icon]) => ({
              id: value,
              label,
              icon: <Icon className="h-3.5 w-3.5" aria-hidden="true" />,
              pressed: obj.align === value,
              onPress: () => actions.setProperty<TextObject>(obj.id, { align: value }, "Align"),
            }))}
          />
        </ControlRow>
        <ColorField label="Color" value={obj.color} onCommit={(c) => c && actions.setProperty<TextObject>(obj.id, { color: c }, "Text color")} />
        <NumberField label="Leading" value={obj.lineHeight} min={0.5} step={0.1} onCommit={(v) => actions.setProperty<TextObject>(obj.id, { lineHeight: v }, "Line height")} />
        <NumberField label="Track" value={obj.letterSpacing ?? 0} step={0.5} onCommit={(v) => actions.setProperty<TextObject>(obj.id, { letterSpacing: v }, "Letter spacing")} suffix="px" />
      </FieldGroup>
      ) : null}
      {!isReadonly ? (
        <FieldGroup title="Background">
          {obj.background ? (
            <>
              <ColorField
                label="Fill"
                value={obj.background}
                allowNoFill
                emptyLabel="None"
                onCommit={(c) => actions.setProperty<TextObject>(obj.id, { background: c }, "Background")}
              />
              <button
                type="button"
                className="inline-flex items-center rounded px-2 py-1 min-h-[24px] text-xs text-editor-accent hover:underline"
                onClick={() => actions.setProperty<TextObject>(obj.id, { background: null }, "Remove background")}
              >
                Remove background
              </button>
            </>
          ) : (
            <button
              type="button"
              className="flex w-full items-center justify-center rounded border border-editor-border px-1 py-1 min-h-[24px] text-xs text-editor-muted hover:bg-editor-accentsoft"
              onClick={() => actions.setProperty<TextObject>(obj.id, { background: { r: 1, g: 1, b: 1, a: 1 } }, "Add background")}
            >
              Add background
            </button>
          )}
        </FieldGroup>
      ) : null}
    </>
  );
}

function ImageControls({ obj }: { obj: ImageObject }) {
  const { actions } = useEditorContext();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const crop = obj.crop;
  return (
    <>
      <FieldGroup title="Image">
        {/* Full-width in its own row; the grid callers size it by their columns. */}
        <div className="grid min-w-0 grid-cols-1">
          <SecondaryButton title="Replace this image" onClick={() => fileRef.current?.click()}>
            <Replace className="h-3.5 w-3.5" /> Replace image
          </SecondaryButton>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setError(null);
            try {
              const dataUrl = await readImageFileAsDataUrl(file);
              const dims = await decodeImageDimensions(dataUrl);
              actions.setProperty<ImageObject>(obj.id, { src: dataUrl, naturalWidth: dims.width, naturalHeight: dims.height, crop: null }, "Replace image");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "The selected image could not be loaded.");
            }
          }}
        />
        {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
      </FieldGroup>
      <FieldGroup title="Crop (natural px)">
        <NumberField label="X" value={crop?.x ?? 0} onCommit={(v) => commitCropField({ x: v })} />
        <NumberField label="Y" value={crop?.y ?? 0} onCommit={(v) => commitCropField({ y: v })} />
        <NumberField label="W" value={crop?.width ?? obj.naturalWidth} onCommit={(v) => commitCropField({ width: v })} />
        <NumberField label="H" value={crop?.height ?? obj.naturalHeight} onCommit={(v) => commitCropField({ height: v })} />
        {crop ? <button className="text-xs text-editor-accent hover:underline" onClick={() => actions.setProperty<ImageObject>(obj.id, { crop: null }, "Reset crop")}>Reset crop</button> : null}
        <p className="text-xs text-editor-muted">
          These fields are the keyboard-accessible crop editor; press C for the visual crop tool.
        </p>
      </FieldGroup>
    </>
  );

  /**
   * Commits one numeric crop field, SANITIZED by the same domain helper the
   * interactive crop uses — values are clamped inside the image and to the
   * minimum crop size, so the panel can never persist a crop the renderer
   * and export would have to repair.
   */
  function commitCropField(patch: Partial<NonNullable<ImageObject["crop"]>>): void {
    const base = crop ?? fullCrop(obj.naturalWidth, obj.naturalHeight);
    const { changed, next } = resolveCropCommit(
      { ...base, ...patch },
      crop ?? null,
      obj.naturalWidth,
      obj.naturalHeight,
    );
    if (changed) actions.setProperty<ImageObject>(obj.id, { crop: next }, "Crop");
  }
}

const DEFAULT_SHADOW = { offsetX: 2, offsetY: 2, blur: 3, color: { r: 0, g: 0, b: 0, a: 0.35 } };

function ShapeControls({ obj }: { obj: ShapeObject }) {
  const { actions } = useEditorContext();
  const style = obj.style;
  const setStyle = (patch: Partial<ShapeObject["style"]>, label: string) =>
    actions.setProperty<ShapeObject>(obj.id, { style: { ...style, ...patch } }, label);
  const shadow = style.shadow ?? null;
  return (
    <>
      <FieldGroup title="Shape">
        <ColorField label="Fill" value={style.fill} allowNoFill emptyLabel="No fill" onCommit={(c) => setStyle({ fill: c }, "Fill")} />
        <ColorField label="Stroke" value={style.stroke} allowNoFill emptyLabel="No stroke" onCommit={(c) => setStyle({ stroke: c }, "Stroke")} />
        <NumberField label="Stroke" value={style.strokeWidth} min={0} onCommit={(v) => setStyle({ strokeWidth: Math.max(0, v) }, "Stroke width")} suffix="px" />
        <SelectField<DashPresetId>
          label="Dash"
          value={dashPresetOf(style.dash)}
          options={[
            { value: "solid", label: "Solid" },
            { value: "dashed", label: "Dashed" },
            { value: "dotted", label: "Dotted" },
            ...(dashPresetOf(style.dash) === "custom" ? [{ value: "custom" as const, label: "Custom" }] : []),
          ]}
          onCommit={(preset) => setStyle({ dash: dashForPreset(preset, style.dash) }, "Dash")}
        />
        {obj.shape === "rect" || obj.shape === "roundedRect" ? (
          <NumberField label="Radius" value={style.cornerRadius} min={0} onCommit={(v) => setStyle({ cornerRadius: Math.max(0, v) }, "Corner radius")} suffix="px" />
        ) : null}
      </FieldGroup>
      <ShapeParamControls obj={obj} />
      <FieldGroup title="Shadow">
        {shadow ? (
          <>
            <NumberField label="X" value={shadow.offsetX} onCommit={(v) => setStyle({ shadow: { ...shadow, offsetX: v } }, "Shadow")} suffix="px" />
            <NumberField label="Y" value={shadow.offsetY} onCommit={(v) => setStyle({ shadow: { ...shadow, offsetY: v } }, "Shadow")} suffix="px" />
            <NumberField label="Blur" value={shadow.blur} min={0} onCommit={(v) => setStyle({ shadow: { ...shadow, blur: Math.max(0, v) } }, "Shadow blur")} suffix="px" />
            <ColorField label="Color" value={shadow.color} onCommit={(c) => c && setStyle({ shadow: { ...shadow, color: c } }, "Shadow color")} />
            <p className="text-xs text-editor-muted">PDF export approximates blur as a hard offset shadow.</p>
            <button className="text-xs text-editor-accent hover:underline" onClick={() => setStyle({ shadow: null }, "Remove shadow")}>
              Remove shadow
            </button>
          </>
        ) : (
          <div className="grid min-w-0 grid-cols-1">
            <SecondaryButton
              title="Add a drop shadow"
              onClick={() => setStyle({ shadow: DEFAULT_SHADOW }, "Add shadow")}
            >
              Add shadow
            </SecondaryButton>
          </div>
        )}
      </FieldGroup>
    </>
  );
}

/** Kind-specific shape parameters (M6.16) — clamped by the DOMAIN helpers. */
function ShapeParamControls({ obj }: { obj: ShapeObject }) {
  const { actions } = useEditorContext();
  const set = (patch: Partial<ShapeObject>, label: string) =>
    actions.setProperty<ShapeObject>(obj.id, patch, label);
  const maxHead = Math.max(2, Math.max(obj.localBounds.width, obj.localBounds.height) * 0.9);

  if (obj.shape === "polygon") {
    return (
      <FieldGroup title="Polygon">
        <NumberField label="Sides" value={clampSides(obj.sides)} min={MIN_POLYGON_SIDES} max={MAX_POLYGON_SIDES} onCommit={(v) => set({ sides: clampSides(v) }, "Polygon sides")} />
      </FieldGroup>
    );
  }
  if (obj.shape === "star") {
    return (
      <FieldGroup title="Star">
        <NumberField label="Points" value={clampStarPoints(obj.starPoints)} min={MIN_STAR_POINTS} max={MAX_STAR_POINTS} onCommit={(v) => set({ starPoints: clampStarPoints(v) }, "Star points")} />
        <NumberField label="Inner" value={clampInnerRatio(obj.innerRatio)} min={MIN_INNER_RATIO} max={MAX_INNER_RATIO} step={0.05} onCommit={(v) => set({ innerRatio: clampInnerRatio(v) }, "Star inner ratio")} />
      </FieldGroup>
    );
  }
  if (obj.shape === "arrow") {
    return (
      <FieldGroup title="Arrow">
        <SelectField
          label="Head"
          value={obj.headType ?? "triangle"}
          options={[{ value: "triangle", label: "Triangle" }, { value: "open", label: "Open" }]}
          onCommit={(v) => set({ headType: v }, "Arrowhead")}
        />
        <NumberField label="Head size" value={clampHeadSize(obj.headSize, maxHead)} min={2} onCommit={(v) => set({ headSize: clampHeadSize(v, maxHead) }, "Arrowhead size")} suffix="px" />
      </FieldGroup>
    );
  }
  if (obj.shape === "speechBubble") {
    return (
      <FieldGroup title="Speech bubble">
        <NumberField label="Tail" value={clampTailPosition(obj.tailPosition)} min={0.05} max={0.95} step={0.05} onCommit={(v) => set({ tailPosition: clampTailPosition(v) }, "Tail position")} />
      </FieldGroup>
    );
  }
  if (obj.shape === "connector") {
    return (
      <FieldGroup title="Connector">
        <SelectField
          label="Routing"
          value={obj.connectorKind ?? "straight"}
          options={[{ value: "straight", label: "Straight" }, { value: "elbow", label: "Elbow" }]}
          onCommit={(v) => set({ connectorKind: v }, "Connector routing")}
        />
        <label className="flex items-center gap-2 text-xs text-editor-muted">
          <input type="checkbox" checked={obj.startArrow ?? false} onChange={(e) => set({ startArrow: e.target.checked }, "Start arrow")} className="accent-editor-accent" />
          Start arrowhead
        </label>
        <label className="flex items-center gap-2 text-xs text-editor-muted">
          <input type="checkbox" checked={obj.endArrow ?? true} onChange={(e) => set({ endArrow: e.target.checked }, "End arrow")} className="accent-editor-accent" />
          End arrowhead
        </label>
        <NumberField label="Head size" value={clampHeadSize(obj.headSize, maxHead)} min={2} onCommit={(v) => set({ headSize: clampHeadSize(v, maxHead) }, "Arrowhead size")} suffix="px" />
      </FieldGroup>
    );
  }
  if (obj.shape === "bezier" || obj.shape === "path") {
    const commands = obj.pathData ? (obj.pathData.match(/[MLCQZ]/gi)?.length ?? 0) : 0;
    return (
      <FieldGroup title="Path">
        <p className="text-xs text-editor-muted">
          {commands > 0 ? `${commands} path command${commands === 1 ? "" : "s"}.` : "Derived from the shape bounds."}
        </p>
        <p className="text-xs text-editor-muted">Edit anchors by recreating with the Pen tool.</p>
      </FieldGroup>
    );
  }
  return null;
}

function HighlightControls({ obj }: { obj: HighlightObject }) {
  const { actions } = useEditorContext();
  return (
    <FieldGroup title="Highlight">
      {/* One control, one value. The picker owns opacity, so the separate
          Opacity slider that used to sit here is gone — two controls writing the
          same channel is the ambiguity the inspector must not have. */}
      <ColorField label="Color" value={obj.color} onCommit={(c) => c && actions.setProperty<HighlightObject>(obj.id, { color: c }, "Color")} />
    </FieldGroup>
  );
}

function DrawingControls({ obj }: { obj: DrawingObject }) {
  const { actions } = useEditorContext();
  const style = obj.style;
  return (
    <FieldGroup title="Drawing">
      <SelectField
        label="Brush"
        value={obj.brush ?? "pen"}
        options={[
          { value: "pen", label: "Pen" },
          { value: "marker", label: "Marker" },
          { value: "highlighter", label: "Highlighter" },
          { value: "pencil", label: "Pencil" },
        ]}
        onCommit={(v) => actions.setProperty<DrawingObject>(obj.id, { brush: v }, "Brush")}
      />
      <ColorField label="Stroke" value={style.stroke} allowNoFill emptyLabel="No stroke" onCommit={(c) => actions.setProperty<DrawingObject>(obj.id, { style: { ...style, stroke: c } }, "Stroke")} />
      <NumberField label="Width" value={style.strokeWidth} min={1} onCommit={(v) => actions.setProperty<DrawingObject>(obj.id, { style: { ...style, strokeWidth: Math.max(1, v) } }, "Stroke width")} suffix="px" />
      <label className="flex items-center gap-2 text-xs text-editor-muted">
        <input
          type="checkbox"
          checked={obj.smoothing ?? false}
          onChange={(e) => actions.setProperty<DrawingObject>(obj.id, { smoothing: e.target.checked }, "Smoothing")}
          className="accent-editor-accent"
        />
        Smooth the stroke
      </label>
    </FieldGroup>
  );
}

function AnnotationControls({ obj }: { obj: AnnotationObject }) {
  const { actions } = useEditorContext();
  return (
    <FieldGroup title="Annotation">
      <textarea
        defaultValue={obj.text}
        onBlur={(e) => actions.setProperty<AnnotationObject>(obj.id, { text: e.target.value }, "Edit note")}
        className="min-h-16 w-full rounded border border-editor-border px-1 py-0.5 text-xs focus:border-editor-accent/70 focus:outline-none"
        data-editor-text-input="true"
      />
      <NumberField label="Size" value={obj.fontSize} min={6} onCommit={(v) => actions.setProperty<AnnotationObject>(obj.id, { fontSize: v }, "Font size")} suffix="pt" />
      <ColorField label="Color" value={obj.color} onCommit={(c) => c && actions.setProperty<AnnotationObject>(obj.id, { color: c }, "Color")} />
      {/* The note panel is document data (v7), so it is editable rather than a
          fixed yellow baked into the renderer. `allowNoFill` is what makes a
          text-only note expressible. */}
      <ColorField label="Note fill" value={obj.background} allowNoFill emptyLabel="No fill" onCommit={(c) => actions.setProperty<AnnotationObject>(obj.id, { background: c }, "Note fill")} />
      <ColorField label="Border" value={obj.border} allowNoFill emptyLabel="No border" onCommit={(c) => actions.setProperty<AnnotationObject>(obj.id, { border: c }, "Note border")} />
    </FieldGroup>
  );
}

function SignatureControls({ obj }: { obj: SignatureObject }) {
  return (
    <FieldGroup title="Signature">
      <p className="text-xs text-editor-muted">Signer: {obj.signer}</p>
      <p className="text-xs text-editor-muted">Visual signature (not cryptographic).</p>
    </FieldGroup>
  );
}
