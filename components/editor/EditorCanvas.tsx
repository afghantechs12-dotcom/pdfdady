"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorContext } from "@/components/editor/EditorContext";
import { ObjectRenderer } from "@/components/editor/canvas/ObjectRenderer";
import { SelectionOverlay, type SnapGuide } from "@/components/editor/canvas/SelectionOverlay";
import { ObjectToolbar } from "@/components/editor/canvas/ObjectToolbar";
import type {
  ObjectToolbarAction,
  ObjectToolbarActionId,
} from "@/components/editor/canvas/objectToolbarActions";
import { affordanceWhileEditing, resolveSelectionAffordance, supportsInlineTextEditing } from "@/components/editor/canvas/selectionAffordances";
import { resolveImagePlacement } from "@/src/application/editor/tools/imagePlacement";
import {
  isTextAreaDrag,
  resolveTextClickPlacement,
  resolveTextDragPlacement,
} from "@/src/application/editor/tools/textPlacement";
import {
  defaultShapeSize,
  isPointOnPage,
  isShapeDrag,
  shapeClickBounds,
  shapeDragBounds,
} from "@/src/application/editor/tools/shapeCreation";
import {
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_LINE_HEIGHT,
  createTextObject,
  shapeLabel,
} from "@/src/domain/editor/objectFactories";
import { TextEditor } from "@/components/editor/canvas/TextEditor";
import { resolveTextExit } from "@/components/editor/canvas/textCommitSemantics";
import type { TextEditEntry } from "@/components/editor/canvas/textEditorGeometry";
import { type EditorTool, isBoxTool, shapeKindForTool } from "@/components/editor/editorTypes";
import {
  objectToSvgMatrix,
  pageToScreen,
  screenToPage,
  type PageScreenOrigin,
  type Viewport,
} from "@/src/application/editor/coordinates/CoordinateSpace";
import {
  pageRotationScreenTransform,
  toMatrixString,
  unrotatePagePoint,
} from "@/src/application/editor/coordinates/PageRotation";
import { MAX_ZOOM, MIN_ZOOM } from "@/components/editor/viewport/zoom";
import { HitTestService } from "@/src/application/editor/hitTesting/HitTestService";
import { createDefaultSnapStrategies } from "@/src/application/editor/extensions/SnapStrategies";
import { CompositeSnapEngine, type ISnapEngine } from "@/src/application/editor/extensions/Snapping";
import { TransformObjectsCommand, RemoveObjectsCommand } from "@/src/application/editor/commands/commands";
import {
  DEFAULT_ERASER_RADIUS,
  topmostErasableAt,
} from "@/src/application/editor/tools/eraserHitTest";
import {
  addAnchor,
  commit as commitPath,
  createPathBuilder,
  dragHandle,
  previewPathData,
  removeLastAnchor,
  type PathBuilderState,
} from "@/src/application/editor/tools/PathBuilder";
import {
  moveObjects,
  resizeObject,
  resizeSelection,
  rotateObjects,
  type ResizeHandle,
} from "@/src/application/editor/transform/TransformService";
import { shouldLockAspect } from "@/src/application/editor/transform/aspectConstraint";
import { pageObjects, worldBounds, getActivePage } from "@/src/domain/editor/document";
import {
  beginPan,
  cancelPan,
  keyboardPanDelta,
  panPosition,
  type PanSession,
} from "@/src/application/editor/tools/panTool";
import {
  compose,
  makeBounds,
  makeScale,
  makeTranslate,
  type AffineTransform,
  type Bounds,
  type Point,
} from "@/src/domain/editor/geometry";
import type { EditorObject, ImageObject, TextObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { isReadonlySourceText } from "@/src/domain/editor/importedTextRendering";
import { CropOverlay } from "@/components/editor/canvas/CropOverlay";
import { fullCrop, moveCrop, resolveCropCommit, sanitizeCrop } from "@/src/application/editor/tools/cropMath";
import { resolveCropEligibility } from "@/src/application/editor/tools/cropEligibility";
import type { InteractionStatus } from "@/components/editor/statusBarLogic";
import { isInteractiveElement, isTextInput } from "@/components/editor/domFocus";
import { decodeImageDimensions, readImageFileAsDataUrl } from "@/src/application/editor/imageValidation";
import {
  DEFAULT_DRAW_SETTINGS,
  drawingOverridesFor,
  effectiveStrokeOpacity,
  type DrawSettings,
} from "@/src/application/editor/tools/drawSettings";
import { editorColorToCss } from "@/lib/editor/color";
import { DRAFT, DRAFT_TINT, DRAFT_TINT_WEAK } from "@/components/editor/canvas/signalColors";

const SNAP_THRESHOLD_PX = 6;
const HIT_TOLERANCE_PX = 4;

export interface EditorCanvasProps {
  viewport: Viewport;
  onViewportChange: (v: Viewport) => void;
  tool: EditorTool;
  onToolChange: (t: EditorTool) => void;
  /**
   * Called when a one-shot tool has finished creating something. The canvas does
   * NOT decide what happens next — whether the tool disarms to Select or stays
   * armed is the pinning policy in `toolSession`, owned above.
   *
   * This is deliberately separate from `onToolChange("select")`, which the crop
   * paths still call: leaving crop is a MODE EXIT, not a completed insertion, and
   * a pinned tool must never keep the user trapped inside crop. Omitted (tests,
   * embedders) falls back to the historical always-return-to-Select behaviour.
   */
  onInsertionComplete?: () => void;
  /**
   * The Draw tool's live brush/color/width/opacity. Owned above the canvas so the
   * toolbar's Draw controls and the stroke being drawn cannot disagree. Omitted
   * (tests, embedders) falls back to the pen defaults.
   */
  drawSettings?: DrawSettings;
  /** Optional per-page background image (e.g. a rendered PDF page data URL). */
  backgroundImageForPage?: (pageId: string) => string | undefined;
  /** Fired on right-click with the page + screen point, so the workspace can show the menu. */
  onContextMenu?: (pagePoint: Point, screenPoint: Point) => void;
  /**
   * Live pointer position in page units (rAF-throttled; null when the pointer
   * leaves the canvas). Feeds the status-bar coordinate readout.
   */
  onPagePointerMove?: (pagePoint: Point | null) => void;
  /**
   * Live interaction state (crop draft size / pen anchor count) for the
   * status bar (M6.14). Published on state TRANSITIONS only, typically into a
   * subject so only the status-bar readout re-renders.
   */
  onInteractionStatusChange?: (status: InteractionStatus) => void;
  /**
   * Reports that the inline text editor holds characters the document does not.
   *
   * Forwarded straight from {@link TextEditor} rather than derived here: this
   * component does not own the textarea's value, and persistence needs the fact
   * from the surface that does.
   */
  onUncommittedInputChange?: (pending: boolean) => void;
  /**
   * The floating contextual object toolbar's actions (P1 Phase G).
   *
   * The canvas renders this bar because it owns the page→screen transform and
   * the inline text editor, but it does NOT own the action policy: the resolved
   * action list and the handlers come from the workspace, which already holds
   * the history-backed `EditorActionHandlers`. Omit to render no bar (tests,
   * embedders).
   */
  objectToolbar?: {
    actions: readonly ObjectToolbarAction[];
    onAction: (id: ObjectToolbarActionId) => void;
  };
}

type Gesture =
  | { mode: "none" }
  | { mode: "marquee"; pointerId: number; startPage: Point; additive: boolean; key: string }
  | {
      mode: "move";
      pointerId: number;
      startPointer: Point;
      key: string;
      before: Record<string, AffineTransform>;
      objs: EditorObject[];
    }
  | {
      mode: "resize";
      pointerId: number;
      handle: ResizeHandle;
      key: string;
      before: Record<string, AffineTransform>;
      singleObj: EditorObject | null;
      objs: EditorObject[];
      selBounds: Bounds;
    }
  | {
      mode: "rotate";
      pointerId: number;
      center: Point;
      startAngle: number;
      key: string;
      before: Record<string, AffineTransform>;
      objs: EditorObject[];
    }
  /**
   * A shape/highlight box tool is pressed. NOTHING is created yet.
   *
   * Creation is deferred to pointer-up so one drag is ONE undo entry. The old
   * design created the object on pointer-down and then resized it on every
   * pointer-move, which stacked `Add object` + `Resize` — so the first Ctrl+Z
   * only undid the sizing and left a differently-sized shape on the page
   * (measured: `Undo Resize` then `Undo Add object`). Deferring also means an
   * Escape or a lost pointer mid-drag has nothing to clean up, and the preview
   * can be honest about the box that will actually be committed.
   */
  | { mode: "shape-place"; pointerId: number; startPage: Point }
  | { mode: "draw"; pointerId: number; startPage: Point; points: Point[] }
  | { mode: "erase"; pointerId: number; erased: Set<string>; began: boolean }
  | { mode: "path-place"; pointerId: number }
  /**
   * Text tool pressed: still undecided between a click (auto-sized box) and a
   * drag (explicit text area). Resolved on pointer-up.
   */
  | { mode: "text-place"; pointerId: number; startPage: Point };

export function EditorCanvas({
  viewport,
  onViewportChange,
  tool,
  onToolChange,
  onInsertionComplete,
  drawSettings = DEFAULT_DRAW_SETTINGS,
  backgroundImageForPage,
  onContextMenu,
  onPagePointerMove,
  onInteractionStatusChange,
  onUncommittedInputChange,
  objectToolbar,
}: EditorCanvasProps) {
  const { state, service, activePage, selection, actions } = useEditorContext();
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<Gesture>({ mode: "none" });
  const gestureKeyCounter = useRef(0);
  // Temporary spacebar hand mode (M6.8): state (not a ref) so the cursor
  // updates; it overlays the active tool without changing it, so releasing
  // Space "restores the previous tool" by construction.
  const [spaceDown, setSpaceDown] = useState(false);
  const panSessionRef = useRef<PanSession | null>(null);
  const panPointerIdRef = useRef<number | null>(null);
  const [panning, setPanning] = useState(false);
  // Latest-value refs so stable window listeners (space/escape/arrows) can
  // read the current viewport without re-subscribing every pan frame.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  /**
   * Mirror of `gestureRef.current.mode !== "none"` as RENDER STATE.
   *
   * The gesture itself must stay a ref: move/resize/rotate write it on every
   * pointer frame, and a state write there would re-render the whole canvas per
   * frame. But anything RENDERED from it — the floating object toolbar, which
   * hides mid-drag — must not read the ref during render. A ref write schedules
   * no render, so a render-time reader is only correct if some *other* state
   * write happens to land on the same tick.
   *
   * Reading the ref did in fact work when this was written, and that is exactly
   * the problem: it worked by accident. Pointer-up calls `setSnapGuides([])`,
   * which allocates a fresh array and so always re-renders, and that incidental
   * render is what let the render-time ref read observe "none" again. Nothing
   * connects snap guides to the toolbar; the dependency is invisible.
   *
   * Verified rather than assumed. Replacing that one line with the ordinary
   * optimization `setSnapGuides(prev => prev.length === 0 ? prev : [])` — "don't
   * re-render when nothing changed", correct in isolation and the kind of change
   * a perf pass makes without a second thought — left the bar permanently
   * invisible after any plain click-to-select, because pointer-up then restores
   * "none" with no state write at all. Six probe checks failed. With the mirror
   * below, that same optimization changes nothing.
   *
   * Every write goes through {@link setGesture} so the two cannot drift.
   */
  const [gestureActive, setGestureActive] = useState(false);
  const setGesture = useCallback((g: Gesture) => {
    gestureRef.current = g;
    // Only the none/not-none TRANSITION is state; the per-frame gesture payload
    // stays in the ref. Returning `prev` unchanged lets React bail out of the
    // re-render, so a drag that stays in "move" costs nothing.
    const active = g.mode !== "none";
    setGestureActive((prev) => (prev === active ? prev : active));
  }, []);
  const cropFocusReturnRef = useRef<HTMLElement | null>(null);
  const pendingImageToolRef = useRef<{ point: Point; kind: "image" | "signature" } | null>(null);
  const longPressRef = useRef<{
    pointerId: number;
    startClient: Point;
    pagePoint: Point;
    timer: ReturnType<typeof setTimeout>;
    fired: boolean;
  } | null>(null);

  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /**
   * How the open text editor was entered, which decides whether it selects the
   * text or places a caret in it (see `textEditorGeometry.caretOnEntry`). The text
   * tool creates an EMPTY box, so `fresh` puts the caret at the start of it;
   * text the user double-clicks is prose one keystroke could destroy, so
   * `existing` puts the caret at the end instead of selecting all of it.
   */
  const [editingEntry, setEditingEntry] = useState<TextEditEntry>("existing");
  /**
   * The text tool's DRAFT object: drawn, editable, and NOT in the document.
   *
   * The tool used to `addText` on pointer-up, so an empty text object entered the
   * document before a character was typed — and Escape, which only closed the
   * editor, left it there. Measured: after typing and escaping, the Layers panel
   * still listed one "Text" row and the history stack still held "Added object",
   * so the user lost their text and kept an invisible, selectable artifact.
   *
   * A draft is the same deferred-commit contract the shape tools ship: nothing
   * enters the document until the gesture completes with content, so Escape has
   * nothing to leave behind. `textCommitSemantics` owns the decision; this state
   * is only where the not-yet-committed object lives. It is never both a draft and
   * an `editingTextId` at once.
   *
   * `position` is carried beside the object because a `TextObject` has no position
   * field — the factory bakes it into `transform` — and commit needs the original
   * point to hand back to `addText`.
   */
  const [textDraftObject, setTextDraftObject] = useState<{
    object: TextObject;
    position: Point;
  } | null>(null);
  /**
   * True while ANY inline text editor is open. Everything that used to test
   * `editingTextId` means this — a draft editor must suppress the object toolbar,
   * the drag handles and object pointer-downs exactly like a committed one does.
   */
  const textEditorOpen = editingTextId != null || textDraftObject != null;
  /**
   * The layer a new object would land on — the same top-of-stack rule
   * `useEditor.addText` applies. Resolved here so the draft is a faithful preview
   * of the object that commit will actually create.
   */
  const topLayerId = (): string => {
    const layers = getActivePage(service.getState()).layerStack.layers;
    return layers[layers.length - 1].id;
  };
  const openTextEditor = (id: string, entry: TextEditEntry) => {
    // Only for objects this canvas can actually put an editor over. The editing
    // id is cleared by the editor's own commit/cancel handlers and nothing else,
    // so setting it for an object that renders no editor wedges the canvas —
    // which is exactly what the annotate tool did (see
    // `supportsInlineTextEditing`).
    if (!supportsInlineTextEditing(getActivePage(service.getState()).objects[id])) return;
    setEditingEntry(entry);
    setEditingTextId(id);
  };
  /**
   * Leaving the inline text editor, for both exits and both session kinds.
   * `textCommitSemantics.resolveTextExit` owns the decision; this only carries it
   * out. The three outcomes:
   *
   *  - `create`  — a draft that carries content becomes a real object. ONE
   *                `addText`, so the whole authoring gesture is ONE history entry
   *                and one Ctrl+Z removes the object rather than emptying it.
   *  - `update`  — an existing object's text actually changed.
   *  - `discard` — leave the document exactly as it was. For a draft that means
   *                nothing was ever added, which is what makes Escape a true
   *                cancel instead of "keep the empty box, drop the words".
   *
   * The editor is closed on every path, so no outcome can wedge it open.
   */
  const leaveTextEditor = (exit: "commit" | "cancel", text: string) => {
    const draft = textDraftObject;
    const target = editingTextId ? getActivePage(service.getState()).objects[editingTextId] : null;
    const existingText = target && isObjectKind(target, "text") ? target.text : "";
    const outcome = resolveTextExit(
      { session: draft ? "draft" : "existing", initialText: draft ? "" : existingText },
      exit,
      text,
    );
    if (outcome === "create" && draft) {
      const id = actions.addText(draft.position, {
        text,
        localBounds: draft.object.localBounds,
      });
      // Select what was just authored, so handles, the contextual bar and the
      // Inspector are immediately about the new object — the same close-out the
      // shape tools do.
      actions.select(id);
    } else if (outcome === "update" && target) {
      actions.setProperty<TextObject>(target.id, { text }, "Edit text");
    }
    setTextDraftObject(null);
    setEditingTextId(null);
  };
  const [drawingPoints, setDrawingPoints] = useState<Point[] | null>(null);
  /** The box tools' in-progress rectangle while dragging, in page space. */
  const [shapeDraft, setShapeDraft] = useState<{ from: Point; to: Point } | null>(null);
  /** The text tool's in-progress area while dragging, in page space. */
  const [textDraft, setTextDraft] = useState<{ from: Point; to: Point } | null>(null);
  // Defaulted here rather than at each call site: an embedder that omits the
  // prop gets the historical behaviour (always return to Select), and the five
  // insertion sites stay unconditional calls.
  const insertionComplete = useCallback(() => {
    if (onInsertionComplete) onInsertionComplete();
    else onToolChange("select");
  }, [onInsertionComplete, onToolChange]);

  // Path/pen tool (M6.10): the committed anchors; null = not building.
  const [pathState, setPathState] = useState<PathBuilderState | null>(null);
  const pathPreviewRef = useRef<SVGPathElement>(null);
  // Crop mode (M6.11): the live draft crop in natural px; null = not cropping.
  const [cropDraft, setCropDraft] = useState<Bounds | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // Status-bar interaction feed (M6.14). Published only when the DISPLAYED
  // values change (rounded crop size, anchor count) — a crop-window move or a
  // pen handle drag that doesn't change them publishes nothing, so the
  // status-bar readout re-renders on meaningful transitions, not per frame.
  const onInteractionStatusChangeRef = useRef(onInteractionStatusChange);
  onInteractionStatusChangeRef.current = onInteractionStatusChange;
  const lastInteractionKeyRef = useRef("");
  const interactionKey = `${cropDraft ? `${Math.round(cropDraft.width)}x${Math.round(cropDraft.height)}` : ""}|${pathState?.anchors.length ?? 0}`;
  useEffect(() => {
    if (interactionKey === lastInteractionKeyRef.current) return;
    lastInteractionKeyRef.current = interactionKey;
    onInteractionStatusChangeRef.current?.({
      cropDraft,
      pathAnchorCount: pathState?.anchors.length ?? 0,
    });
  }, [interactionKey, cropDraft, pathState]);
  // Unmounting mid-session must not pin a stale "Crop …" line in the status bar.
  useEffect(
    () => () => {
      lastInteractionKeyRef.current = "";
      onInteractionStatusChangeRef.current?.({ cropDraft: null, pathAnchorCount: 0 });
    },
    [],
  );

  const hitTest = useMemo(() => new HitTestService(), []);

  const origin: PageScreenOrigin = viewport.pan;

  // Page rotation (M6): objects live in UNROTATED page coordinates; the whole
  // page surface (background + objects + selection chrome) is rotated for
  // display by one screen-space group transform, and pointer input inverts the
  // rotation in `toPage` — so editing keeps working on a rotated page and the
  // canvas shows exactly what export's `page.setRotation` produces.
  const pageRotation = activePage.rotation;
  const surfaceTransform =
    pageRotation === 0
      ? undefined
      : toMatrixString(
          pageRotationScreenTransform(pageRotation, activePage.width, activePage.height, viewport, origin),
        );

  const objects = useMemo(() => pageObjects(activePage), [activePage]);

  // The snap engine is rebuilt when the page contents or zoom change; strategies
  // read the live objects (excluding dragged ids) + page size + the shared guide engine.
  const snapEngine: ISnapEngine = useMemo(() => {
    const others = () =>
      pageObjects(getActivePage(service.getState()))
        .filter((o) => !state.selection.ids.includes(o.id))
        .map((o) => ({ id: o.id, bounds: worldBounds(o) }));
    return new CompositeSnapEngine(
      createDefaultSnapStrategies({
        pageSize: { width: activePage.width, height: activePage.height },
        getOtherObjects: others,
        guideEngine: service.plugins.guidesEngine,
      }),
    );
  }, [activePage, service, state.selection.ids]);

  const snapThreshold = SNAP_THRESHOLD_PX / viewport.zoom;

  /**
   * Converts a pointer event to page-space coordinates: screen → displayed
   * page space, then the page-rotation inverse back to unrotated page space
   * (the space objects, hit-testing, and transforms live in).
   */
  const toPage = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const displayPoint = screenToPage(viewport, origin, {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      return unrotatePagePoint(pageRotation, activePage.width, activePage.height, displayPoint);
    },
    [viewport, origin, pageRotation, activePage.width, activePage.height],
  );

  // rAF-throttled pointer-coordinate publisher for the status bar.
  const coordsRafRef = useRef<number | null>(null);
  const pendingCoordsRef = useRef<Point | null>(null);
  const publishCoords = useCallback(
    (p: Point | null) => {
      if (!onPagePointerMove) return;
      pendingCoordsRef.current = p;
      if (p === null) {
        // Leaving the canvas reports immediately so no stale frame wins.
        if (coordsRafRef.current !== null) {
          cancelAnimationFrame(coordsRafRef.current);
          coordsRafRef.current = null;
        }
        onPagePointerMove(null);
        return;
      }
      if (coordsRafRef.current !== null) return;
      coordsRafRef.current = requestAnimationFrame(() => {
        coordsRafRef.current = null;
        onPagePointerMove(pendingCoordsRef.current);
      });
    },
    [onPagePointerMove],
  );
  useEffect(
    () => () => {
      if (coordsRafRef.current !== null) cancelAnimationFrame(coordsRafRef.current);
    },
    [],
  );

  const nextGestureKey = useCallback(() => `gesture-${++gestureKeyCounter.current}`, []);

  /** Snaps a page-space pointer during a drag; returns the snapped point + sets guide state. */
  const snapPointer = useCallback(
    (pointer: Point, draggedIds: string[]): Point => {
      const result = snapEngine.snap({
        pointer,
        draggedIds,
        threshold: snapThreshold,
        zoom: viewport.zoom,
      });
      if (result.active) {
        const guides: SnapGuide[] = [];
        if (Math.abs(result.dx) > 0) guides.push({ x: result.point.x });
        if (Math.abs(result.dy) > 0) guides.push({ y: result.point.y });
        setSnapGuides(guides);
        return result.point;
      }
      setSnapGuides([]);
      return pointer;
    },
    [snapEngine, snapThreshold, viewport.zoom],
  );

  const captureBefore = (ids: string[]): Record<string, AffineTransform> => {
    const page = getActivePage(service.getState());
    const out: Record<string, AffineTransform> = {};
    for (const id of ids) {
      const o = page.objects[id];
      if (o) out[id] = o.transform;
    }
    return out;
  };

  // --- Box tools (shapes + highlight) ----------------------------------------
  /**
   * Commits exactly one shape/highlight for a finished box gesture.
   *
   * ONE history entry, ALWAYS: a single `Add …` command labelled for the thing
   * created, so Undo removes the shape in one press. Previously this was two
   * entries — the object was created on pointer-down and then resized on every
   * pointer-move — so the first Ctrl+Z undid only the sizing and left a
   * differently-sized shape on the page.
   *
   * The dragged rectangle is passed to the factory as `localBounds`, so the
   * object IS the box the user drew and no scaling step is involved at all. The
   * previous code scaled the factory's default bounds by `dragExtent / 100`,
   * where 100 was a local constant and the factories actually default to 120
   * (shapes) and 160×28 (highlight) — which is why every committed shape came out
   * 1.2× the size of the drag.
   */
  const commitShape = useCallback(
    (start: Point, end: Point) => {
      setShapeDraft(null);
      const page = getActivePage(service.getState());
      const pageSize = { width: page.width, height: page.height };
      // A click (no meaningful drag) places a sensible default-size shape centred
      // on the press; a drag uses exactly the rectangle drawn. Either way the
      // result is clamped onto the page and can never be zero-area.
      const target = isShapeDrag(start, end)
        ? shapeDragBounds(start, end, pageSize)
        : shapeClickBounds(start, defaultShapeSize(pageSize), pageSize);
      const position = { x: target.x, y: target.y };
      const localBounds = makeBounds(0, 0, target.width, target.height);

      const kind = shapeKindForTool(tool);
      const id = kind
        ? actions.addShape(position, kind, {
            localBounds,
            name: shapeLabel(kind),
          })
        : actions.addHighlight(position, { localBounds });
      // Select what was just created, so handles, the contextual bar and the
      // Inspector are immediately about the new object.
      actions.select(id);
      insertionComplete();
    },
    [actions, service, tool, insertionComplete],
  );

  /** Abandons an in-progress box gesture without creating anything. */
  const cancelShapeGesture = useCallback(() => {
    setShapeDraft(null);
    setGesture({ mode: "none" });
  }, [setGesture]);

  /** Abandons an in-progress freehand stroke without committing it. */
  const cancelDrawGesture = useCallback(() => {
    setDrawingPoints(null);
    setGesture({ mode: "none" });
  }, [setGesture]);

  /*
   * The Escape/space listener below is registered ONCE (deps `[service]`) so a
   * drag does not re-subscribe it every frame. It therefore must not close over
   * these callbacks directly — it would capture the first render's copies. Latest
   * -value refs keep one listener and current behaviour.
   */
  const cancelShapeGestureRef = useRef(cancelShapeGesture);
  cancelShapeGestureRef.current = cancelShapeGesture;
  const cancelDrawGestureRef = useRef(cancelDrawGesture);
  cancelDrawGestureRef.current = cancelDrawGesture;

  // --- Eraser (M6.9) ----------------------------------------------------------
  const eraserCircleRef = useRef<SVGCircleElement>(null);

  /**
   * Erases the topmost eligible object under the eraser at `pagePoint`. The
   * whole drag is ONE undo entry: a history transaction opens on the first hit
   * and commits on pointer-up. `g.erased` suppresses duplicate deletes for the
   * same object within one gesture.
   */
  const tryErase = (g: Extract<Gesture, { mode: "erase" }>, pagePoint: Point) => {
    const page = getActivePage(service.getState());
    const radiusPage = DEFAULT_ERASER_RADIUS / viewport.zoom;
    const id = topmostErasableAt(pageObjects(page), pagePoint, radiusPage, g.erased);
    if (!id) return;
    const obj = page.objects[id];
    if (!obj) return;
    if (!g.began) {
      service.beginTransaction("Erase");
      g.began = true;
    }
    service.execute(new RemoveObjectsCommand("Erase", [obj]));
    g.erased.add(id);
  };

  /** Ends an erase gesture: commit what was erased, or no-op if nothing was. */
  const finishErase = (g: Extract<Gesture, { mode: "erase" }>) => {
    if (g.began) service.commit();
  };

  // --- Path/pen tool (M6.10) --------------------------------------------------
  /**
   * Finishes the path (Enter / double-click): commits the anchors through the
   * pure builder, creates ONE undoable path shape via the command system, and
   * returns to the select tool. Fewer than two distinct anchors → no object.
   */
  const finishPath = useCallback(() => {
    setGesture({ mode: "none" });
    if (!pathState) return;
    setPathState(null);
    const committed = commitPath(pathState);
    if (!committed) return; // fewer than 2 distinct anchors — nothing to create
    const id = actions.addShape(committed.position, "path", {
      pathData: committed.pathData,
      localBounds: committed.localBounds,
    });
    actions.select(id);
    insertionComplete();
  }, [pathState, actions, insertionComplete]);

  // Path keyboard interaction while building: Enter finishes, Escape cancels,
  // Backspace/Delete removes the last anchor. Registered in the CAPTURE phase
  // with stopPropagation so the global shortcut manager (delete-selection,
  // escape-clears-selection) never double-handles these keys mid-creation.
  useEffect(() => {
    if (!pathState) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finishPath();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPathState(null);
        setGesture({ mode: "none" });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        setPathState((s) => (s ? removeLastAnchor(s) : s));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pathState, finishPath]);

  // Switching away from the path tool resolves the in-progress path safely
  // (cancel — nothing is created without an explicit finish).
  useEffect(() => {
    if (tool !== "path") setPathState(null);
  }, [tool]);

  // Switching tools mid-gesture must not leave a draft rectangle painted over
  // the page. Nothing is created (creation happens on pointer-up), so the
  // gesture is simply dropped.
  useEffect(() => {
    if (!isBoxTool(tool)) setShapeDraft(null);
  }, [tool]);

  // --- Crop mode (M6.11) ------------------------------------------------------
  // Valid only for exactly one selected, unlocked image with real natural
  // dimensions (a 0×0 natural size would make the overlay math NaN — same
  // guard cropDrawSpec applies on the render/export side).
  // The resolved selection (ids → objects, dropping any that vanished). Shared by
  // the crop eligibility check and the selection-chrome affordance, so both judge
  // the same set.
  const selectedObjects = state.selection.ids
    .map((id) => activePage.objects[id])
    .filter((obj): obj is EditorObject => Boolean(obj));
  // What chrome the selection may show. A read-only imported PDF run gets a
  // text-range highlight instead of a transform box — see selectionAffordances.
  const selectionAffordance = resolveSelectionAffordance(selectedObjects);
  const cropEligibility = resolveCropEligibility(selectedObjects);
  const cropTarget = tool === "crop" && cropEligibility.available ? cropEligibility.image ?? null : null;

  // Entering crop mode without a valid image bounces back to select; a valid
  // entry seeds the draft with the PERSISTED crop (sanitized). Re-seeds when
  // the target OR its persisted crop changes — an external crop edit (undo,
  // the panel's numeric fields) must not leave a stale draft that Enter would
  // silently re-commit over the newer value (M6 review QA-2/ARCH-3).
  const persistedCrop = cropTarget?.crop ?? null;
  useEffect(() => {
    if (tool !== "crop") {
      setCropDraft(null);
      return;
    }
    if (!cropTarget) {
      onToolChange("select");
      return;
    }
    setCropDraft(
      sanitizeCrop(
        persistedCrop ?? fullCrop(cropTarget.naturalWidth, cropTarget.naturalHeight),
        cropTarget.naturalWidth,
        cropTarget.naturalHeight,
      ),
    );
    // Draft edits don't loop back here: the draft is local state, and this
    // effect keys on the PERSISTED crop values, which drafts never touch.
  }, [
    tool,
    cropTarget?.id,
    persistedCrop?.x,
    persistedCrop?.y,
    persistedCrop?.width,
    persistedCrop?.height,
  ]);

  /** Commits the draft as ONE history command (or none when unchanged). */
  const commitCrop = useCallback(() => {
    if (!cropTarget || !cropDraft) return;
    // Pure decision logic shared with the integration tests: sanitize, map a
    // full-image crop to null, and suppress no-op commits (no history entry).
    const { changed, next } = resolveCropCommit(
      cropDraft,
      cropTarget.crop ?? null,
      cropTarget.naturalWidth,
      cropTarget.naturalHeight,
    );
    if (changed) {
      actions.setProperty<ImageObject>(cropTarget.id, { crop: next }, "Crop image");
    }
    setCropDraft(null);
    onToolChange("select");
  }, [cropTarget, cropDraft, actions, onToolChange]);

  /** Cancels crop mode; the persisted crop was never touched. */
  const cancelCrop = useCallback(() => {
    setCropDraft(null);
    onToolChange("select");
  }, [onToolChange]);

  // Crop keyboard interaction: Enter commits, Escape cancels, arrows move the
  // window (Shift = 10 px), Delete/Backspace resets the draft to the full
  // image (they must NOT fall through to the global delete-selection, which
  // would delete the image being cropped — M6 review QA-9). Capture phase +
  // stopPropagation so the global shortcut manager never double-handles these
  // keys mid-crop; keys pressed while an interactive control (button/select)
  // is focused belong to that control and are left alone (A11Y-9). The
  // listener itself is registered once per crop session — changing values are
  // read through a latest-value ref so a crop drag doesn't churn it.
  const cropKeyStateRef = useRef({ cropTarget, commitCrop, cancelCrop });
  cropKeyStateRef.current = { cropTarget, commitCrop, cancelCrop };
  const cropSessionActive = tool === "crop" && cropDraft !== null && cropTarget !== null;
  useEffect(() => {
    if (!cropSessionActive) return;
    cropFocusReturnRef.current = document.activeElement as HTMLElement | null;
    canvasContainerRef.current?.focus();
    return () => {
      cropFocusReturnRef.current?.focus?.();
      cropFocusReturnRef.current = null;
    };
  }, [cropSessionActive]);
  useEffect(() => {
    if (!cropSessionActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (isInteractiveElement(e.target)) return;
      const { cropTarget: target, commitCrop: commit, cancelCrop: cancel } = cropKeyStateRef.current;
      if (!target) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        setCropDraft(fullCrop(target.naturalWidth, target.naturalHeight));
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setCropDraft((d) =>
          d ? moveCrop(d, dx, dy, target.naturalWidth, target.naturalHeight) : d,
        );
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cropSessionActive]);

  // --- Object selection + move start -----------------------------------------
  const onObjectPointerDown = (e: React.PointerEvent, obj: EditorObject) => {
    if (spaceDown) return;
    if (e.pointerType === "touch" && tool === "select") {
      const pagePoint = toPage(e);
      const session = {
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        pagePoint,
        fired: false,
        timer: setTimeout(() => {
          const current = longPressRef.current;
          if (!current || current.pointerId !== e.pointerId) return;
          current.fired = true;
          setGesture({ mode: "none" });
          if (!service.getState().selection.ids.includes(obj.id)) actions.select(obj.id);
          onContextMenu?.(current.pagePoint, current.startClient);
        }, 550),
      };
      longPressRef.current = session;
    } // temporary hand mode — let the event pan, not move
    if (tool !== "select" || textEditorOpen) return;
    if (e.button === 2) return; // right-click → context menu (handled on root)
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pagePoint = toPage(e);
    const isSelected = state.selection.ids.includes(obj.id);
    if (e.shiftKey) {
      actions.toggleSelection(obj.id);
    } else if (!isSelected) {
      actions.select(obj.id);
    }
    const ids = isSelected && !e.shiftKey ? state.selection.ids : [obj.id];
    const objs = ids
      .map((id) => getActivePage(service.getState()).objects[id])
      .filter((o): o is EditorObject => Boolean(o));
    // Read-only imported PDF text is SELECTABLE but not movable: it has no
    // transform handles (see selectionAffordances), and dragging its body would
    // reintroduce the same lie by another route. The click above still selected
    // it, so the inspector explains the run and offers Copy text.
    if (!resolveSelectionAffordance(objs).allowsGeometry) {
      setGesture({ mode: "none" });
      return;
    }
    setGesture({
      mode: "move",
      pointerId: e.pointerId,
      startPointer: pagePoint,
      key: nextGestureKey(),
      before: captureBefore(ids),
      objs,
    });
  };

  // --- Canvas background pointer-down (pan / marquee / create) ---------------
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    if (e.pointerType === "touch" && tool === "select") {
      const pagePoint = toPage(e);
      const session = {
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        pagePoint,
        fired: false,
        timer: setTimeout(() => {
          const current = longPressRef.current;
          if (!current || current.pointerId !== e.pointerId) return;
          current.fired = true;
          setGesture({ mode: "none" });
          setMarquee(null);
          const hitId = hitTest.hitTestPoint(activePage, current.pagePoint, {
            tolerance: HIT_TOLERANCE_PX / viewport.zoom,
          });
          if (hitId) {
            if (!service.getState().selection.ids.includes(hitId)) actions.select(hitId);
          } else {
            actions.clearSelection();
          }
          onContextMenu?.(current.pagePoint, { x: current.startClient.x, y: current.startClient.y });
        }, 550),
      };
      longPressRef.current = session;
    }
    // Hand tool, temporary spacebar hand, or middle-button: pan the viewport.
    // Never touches document objects or history — viewport state only.
    if (tool === "hand" || spaceDown || e.button === 1) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panSessionRef.current = beginPan({ x: e.clientX, y: e.clientY }, viewport.pan);
      panPointerIdRef.current = e.pointerId;
      setPanning(true);
      return;
    }
    const pagePoint = toPage(e);
    if (tool === "crop") return; // the crop overlay owns all pointer input
    if (tool === "select") {
      if (!e.shiftKey) actions.clearSelection();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setGesture({ mode: "marquee", pointerId: e.pointerId, startPage: pagePoint, additive: e.shiftKey, key: nextGestureKey() });
      setMarquee({ x: pagePoint.x, y: pagePoint.y, width: 0, height: 0 });
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "path") {
      // Click adds an anchor; dragging before release pulls its out-handle
      // (pen-tool behavior — the move handler feeds dragHandle while down).
      if (!pathState) actions.clearSelection();
      setPathState(addAnchor(pathState ?? createPathBuilder(), pagePoint));
      setGesture({ mode: "path-place", pointerId: e.pointerId });
      return;
    }
    if (tool === "eraser") {
      const g: Extract<Gesture, { mode: "erase" }> = { mode: "erase", pointerId: e.pointerId, erased: new Set(), began: false };
      setGesture(g);
      tryErase(g, pagePoint);
      return;
    }
    if (tool === "text") {
      // Defer creation to pointer-up: a click places an auto-sized box, a drag
      // draws an explicit text area. Creating on pointer-down would commit to the
      // click shape before we know which gesture this is.
      setGesture({ mode: "text-place", pointerId: e.pointerId, startPage: pagePoint });
      setTextDraft({ from: pagePoint, to: pagePoint });
      return;
    }
    if (tool === "annotation") {
      // No inline editor for a note: the canvas renders that editor for text
      // objects only, and the Inspector's Annotation field is where a note's text
      // is edited. Opening one here set an editing id nothing could clear — see
      // `supportsInlineTextEditing`, which now refuses it at the source.
      actions.addAnnotation(pagePoint, { text: "Note" });
      insertionComplete();
      return;
    }
    if (tool === "draw") {
      setGesture({ mode: "draw", pointerId: e.pointerId, startPage: pagePoint, points: [{ x: 0, y: 0 }] });
      setDrawingPoints([{ x: pagePoint.x, y: pagePoint.y }]);
      return;
    }
    if (tool === "image" || tool === "signature") {
      pendingImageToolRef.current = { point: pagePoint, kind: tool };
      fileInputRef.current?.click();
      return;
    }
    if (isBoxTool(tool)) {
      // A box tool must start ON the page: an object created in the surrounding
      // gray workspace belongs to no page and cannot be exported (measured
      // defect — a drag starting 32px left of the page committed an object
      // there). Refusing the gesture is honest; silently relocating it is not.
      if (!isPointOnPage(pagePoint, { width: activePage.width, height: activePage.height })) return;
      setGesture({ mode: "shape-place", pointerId: e.pointerId, startPage: pagePoint });
      setShapeDraft({ from: pagePoint, to: pagePoint });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const longPress = longPressRef.current;
    if (longPress?.pointerId === e.pointerId) {
      const distance = Math.hypot(e.clientX - longPress.startClient.x, e.clientY - longPress.startClient.y);
      if (distance > 8) {
        clearTimeout(longPress.timer);
        longPressRef.current = null;
      }
    }
    publishCoords(toPage(e));
    // The eraser's screen-space cursor circle follows every move (hover too),
    // via a direct attribute write — no React state per pointer frame.
    if (tool === "eraser" && eraserCircleRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      eraserCircleRef.current.setAttribute("cx", String(e.clientX - rect.left));
      eraserCircleRef.current.setAttribute("cy", String(e.clientY - rect.top));
      eraserCircleRef.current.setAttribute("opacity", "1");
    }
    // Pan runs outside the gesture machine (it edits the viewport, never the
    // document), so it is checked BEFORE the no-gesture early return.
    if (panSessionRef.current) {
      if (panPointerIdRef.current !== e.pointerId) return;
      onViewportChange({
        ...viewport,
        pan: panPosition(panSessionRef.current, { x: e.clientX, y: e.clientY }),
      });
      return;
    }
    const g = gestureRef.current;
    if (g.mode !== "none" && g.pointerId !== e.pointerId) return;
    if (g.mode === "none") {
      // Path-tool rubber band on hover: preview the segment from the last
      // anchor to the cursor via a direct attribute write (no re-render).
      if (tool === "path" && pathState && pathPreviewRef.current) {
        const pagePoint = toPage(e);
        pathPreviewRef.current.setAttribute("d", previewPathData(addAnchor(pathState, pagePoint)));
      }
      return;
    }
    const pagePoint = toPage(e);

    if (g.mode === "path-place") {
      // Still holding the placing press: drag the new anchor's out-handle.
      setPathState((s) => (s ? dragHandle(s, pagePoint) : s));
      return;
    }

    if (g.mode === "marquee") {
      const b = makeBounds(
        Math.min(g.startPage.x, pagePoint.x),
        Math.min(g.startPage.y, pagePoint.y),
        Math.abs(pagePoint.x - g.startPage.x),
        Math.abs(pagePoint.y - g.startPage.y),
      );
      setMarquee(b);
      return;
    }
    if (g.mode === "move") {
      const snapped = snapPointer(pagePoint, g.objs.map((o) => o.id));
      const delta = { x: snapped.x - g.startPointer.x, y: snapped.y - g.startPointer.y };
      const after = moveObjects(g.objs, delta);
      service.execute(new TransformObjectsCommand("Move", g.before, after, g.key));
      return;
    }
    if (g.mode === "resize") {
      const snapped = snapPointer(pagePoint, g.objs.map((o) => o.id));
      let after: Record<string, AffineTransform>;
      if (g.singleObj) {
        // Read Shift on every MOVE, not once at pointer-down: the constraint is a
        // live modifier — pressing or releasing Shift mid-drag has to take effect
        // on the next frame, which is what makes it feel like a constraint rather
        // than a mode.
        const lockAspect = shouldLockAspect(g.singleObj, e.shiftKey);
        after = { [g.singleObj.id]: resizeObject(g.singleObj, g.handle, snapped, undefined, lockAspect) };
      } else {
        after = resizeSelection(g.objs, g.selBounds, g.handle, snapped);
      }
      service.execute(new TransformObjectsCommand("Resize", g.before, after, g.key));
      return;
    }
    if (g.mode === "rotate") {
      const angle = Math.atan2(pagePoint.y - g.center.y, pagePoint.x - g.center.x);
      const delta = angle - g.startAngle;
      const after = rotateObjects(g.objs, g.center, delta);
      service.execute(new TransformObjectsCommand("Rotate", g.before, after, g.key));
      return;
    }
    if (g.mode === "shape-place") {
      // Preview only — the object is created on pointer-up. The draft is clamped
      // by the same pure helper the commit uses, so what is previewed is exactly
      // what will be committed.
      setShapeDraft({ from: g.startPage, to: pagePoint });
      return;
    }
    if (g.mode === "erase") {
      tryErase(g, pagePoint);
      return;
    }
    if (g.mode === "draw") {
      const local = { x: pagePoint.x - g.startPage.x, y: pagePoint.y - g.startPage.y };
      g.points.push(local);
      setDrawingPoints(g.points.map((p) => ({ x: p.x + g.startPage.x, y: p.y + g.startPage.y })));
    }
    if (g.mode === "text-place") {
      setTextDraft({ from: g.startPage, to: pagePoint });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const longPress = longPressRef.current;
    if (longPress?.pointerId === e.pointerId) {
      clearTimeout(longPress.timer);
      longPressRef.current = null;
      if (longPress.fired) return;
    }
    const g = gestureRef.current;
    if (panSessionRef.current && panPointerIdRef.current !== e.pointerId) return;
    if (g.mode !== "none" && g.pointerId !== e.pointerId) return;
    panSessionRef.current = null;
    panPointerIdRef.current = null;
    setPanning(false);
    setSnapGuides([]);

    if (g.mode === "marquee" && marquee) {
      const ids = hitTest.hitTestMarquee(activePage, marquee);
      if (ids.length > 0) {
        if (g.additive) ids.forEach((id) => actions.addToSelection(id));
        else actions.selectMany(ids);
      }
      setMarquee(null);
    }
    if (g.mode === "shape-place") {
      commitShape(g.startPage, toPage(e));
    }
    if (g.mode === "draw") {
      const pts = g.points;
      if (pts.length >= 2) {
        // Carry the live brush/color/width into the object, so the stroke that
        // lands matches the one the user just watched being drawn.
        actions.addDrawing(g.startPage, pts, drawingOverridesFor(drawSettings));
      }
      setDrawingPoints(null);
    }
    if (g.mode === "text-place") {
      // Click → auto-sized box at the click point. Drag → the drawn area.
      // Either way the caret opens immediately: a placed text box the user must
      // click again before typing is the "low-level primitive" feel the review
      // flagged.
      //
      // What opens is a DRAFT, not a document object. The editor renders over it
      // exactly the same way, but until the user commits something with content
      // there is nothing in the document to leave behind — so Escape genuinely
      // cancels, and the whole authoring gesture is ONE history entry instead of
      // "Added object" plus "Edited text". See `textCommitSemantics`.
      const page = getActivePage(service.getState());
      const pageSize = { width: page.width, height: page.height };
      const lineHeight = Math.ceil(DEFAULT_TEXT_FONT_SIZE * DEFAULT_TEXT_LINE_HEIGHT);
      const end = toPage(e);
      const placement = isTextAreaDrag(g.startPage, end)
        ? resolveTextDragPlacement(g.startPage, end, pageSize, lineHeight)
        : resolveTextClickPlacement(g.startPage, pageSize, lineHeight);
      setTextDraft(null);
      setTextDraftObject({
        object: createTextObject(placement.position, topLayerId(), {
          text: "",
          localBounds: placement.localBounds,
        }),
        position: placement.position,
      });
      insertionComplete();
    }
    if (g.mode === "erase") {
      finishErase(g);
    }
    setGesture({ mode: "none" });
  };

  // --- Handle pointer-down (resize/rotate) coming from the SelectionOverlay --
  const onHandlePointerDown = (handle: ResizeHandle | "rotate", e: React.PointerEvent) => {
    if (textEditorOpen) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pagePoint = toPage(e);
    const ids = state.selection.ids;
    const objs = ids
      .map((id) => getActivePage(service.getState()).objects[id])
      .filter((o): o is EditorObject => Boolean(o));
    const before = captureBefore(ids);
    if (handle === "rotate") {
      const bounds = selection.bounds;
      const center = bounds
        ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
        : pagePoint;
      const startAngle = Math.atan2(pagePoint.y - center.y, pagePoint.x - center.x);
      setGesture({ mode: "rotate", pointerId: e.pointerId, center, startAngle, key: nextGestureKey(), before, objs });
    } else {
      const singleObj = ids.length === 1 ? objs[0] : null;
      setGesture({
        mode: "resize",
        pointerId: e.pointerId,
        handle,
        key: nextGestureKey(),
        before,
        singleObj,
        objs,
        selBounds: selection.bounds ?? makeBounds(0, 0, 0, 0),
      });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool === "path") {
      // Double-click finishes the path (the two same-point anchors the double
      // click placed are collapsed by the builder's dedupe).
      finishPath();
      return;
    }
    if (tool !== "select") return;
    const pagePoint = toPage(e);
    const id = hitTest.hitTestPoint(activePage, pagePoint, { tolerance: HIT_TOLERANCE_PX / viewport.zoom });
    if (id) {
      const obj = getActivePage(service.getState()).objects[id];
      // A readonly imported run is NOT editable: opening the inline editor over
      // it would put a typed copy on top of original PDF text that is still
      // visible in the page raster — the duplication this design removed. The
      // Properties panel explains why and offers Copy text instead.
      if (obj && isObjectKind(obj, "text")) {
        if (isReadonlySourceText(obj)) return;
        openTextEditor(id, "existing");
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom toward the cursor.
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor));
      // Keep the page point under the cursor stationary.
      const pageUnderCursor = screenToPage(viewport, origin, cursor);
      const newPan = {
        x: cursor.x - pageUnderCursor.x * newZoom,
        y: cursor.y - pageUnderCursor.y * newZoom,
      };
      onViewportChange({ zoom: newZoom, pan: newPan });
    } else {
      onViewportChange({ ...viewport, pan: { x: viewport.pan.x - e.deltaX, y: viewport.pan.y - e.deltaY } });
    }
  };

  const onContextMenuEvent = (e: React.MouseEvent) => {
    e.preventDefault();
    const pagePoint = toPage(e);
    // Standard editor behavior (M6 review QA-1): right-click acts on the
    // object UNDER THE CURSOR. If it isn't already in the selection, select
    // it; right-clicking empty canvas clears the selection — so the menu the
    // workspace opens always describes what the pointer is on.
    const hitId = hitTest.hitTestPoint(activePage, pagePoint, {
      tolerance: HIT_TOLERANCE_PX / viewport.zoom,
    });
    if (hitId) {
      if (!state.selection.ids.includes(hitId)) actions.select(hitId);
    } else if (state.selection.ids.length > 0) {
      actions.clearSelection();
    }
    // Client (viewport) coordinates — the context menu uses fixed positioning.
    onContextMenu?.(pagePoint, { x: e.clientX, y: e.clientY });
  };

  // Temporary spacebar hand mode + Escape pan-cancel (M6.8). Stable listeners;
  // current viewport comes from refs so panning doesn't re-subscribe per frame.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTextInput(e.target)) setSpaceDown(true);
      if (e.key === "Escape") {
        if (panSessionRef.current) {
          // Cancel the active pan: jump back to where the drag started.
          onViewportChangeRef.current({
            ...viewportRef.current,
            pan: cancelPan(panSessionRef.current),
          });
          panSessionRef.current = null;
          panPointerIdRef.current = null;
          setPanning(false);
        }
        const g = gestureRef.current;
        if (g.mode === "erase") {
          // Cancel the erase gesture: roll the open transaction back so every
          // object deleted during this drag is restored.
          if (g.began) service.rollback();
          setGesture({ mode: "none" });
        }
        if (g.mode === "shape-place") {
          // Abandon an in-progress box gesture. Nothing has been created yet
          // (creation is deferred to pointer-up), so this only drops the preview
          // — there is no half-made object to remove and no history to unwind.
          cancelShapeGestureRef.current();
        }
        if (g.mode === "draw") {
          // Same for a freehand stroke: the points live in the gesture, so
          // dropping it leaves no orphan preview and no committed stroke.
          cancelDrawGestureRef.current();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [service]);

  // Keyboard alternative to hand-tool dragging (M6.8): with the hand tool
  // active and nothing selected, arrow keys pan the viewport (Shift = larger
  // step). With a selection, arrows keep their nudge meaning (useShortcuts).
  const selectionEmpty = state.selection.ids.length === 0;
  useEffect(() => {
    if (tool !== "hand" || !selectionEmpty) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const delta = keyboardPanDelta(e.key, e.shiftKey);
      if (!delta) return;
      e.preventDefault();
      const v = viewportRef.current;
      onViewportChangeRef.current({ ...v, pan: { x: v.pan.x + delta.x, y: v.pan.y + delta.y } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, selectionEmpty]);

  // Losing pointer capture (alt-tab, browser gesture, element removal) must
  // never leave the editor stuck mid-gesture: end everything cleanly. An open
  // erase transaction commits (the erases already happened on screen).
  const onLostPointerCapture = (e: React.PointerEvent) => {
    const longPress = longPressRef.current;
    if (longPress?.pointerId === e.pointerId) {
      clearTimeout(longPress.timer);
      longPressRef.current = null;
    }
    const g = gestureRef.current;
    if (
      (panSessionRef.current && panPointerIdRef.current !== e.pointerId) ||
      (g.mode !== "none" && g.pointerId !== e.pointerId)
    ) return;
    panSessionRef.current = null;
    panPointerIdRef.current = null;
    setPanning(false);
    if (g.mode === "erase") finishErase(g);
    setGesture({ mode: "none" });
    setMarquee(null);
    setDrawingPoints(null);
    setTextDraft(null);
    // A box gesture interrupted by a lost capture creates nothing: the draft is
    // the only state it had, so dropping it leaves no orphan preview.
    setShapeDraft(null);
    setSnapGuides([]);
  };

  // File input for image/signature placement.
  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const pending = pendingImageToolRef.current;
    pendingImageToolRef.current = null;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pending) return;
    setImageError(null);
    try {
      const dataUrl = await readImageFileAsDataUrl(file);
      const dims = await decodeImageDimensions(dataUrl);
      // Size against the PAGE, not a fixed box, and centre on the clicked point
      // clamped inside the page — an image that lands half off-page or covering
      // the content underneath is not "inserted" (see imagePlacement).
      const page = getActivePage(service.getState());
      const placement = resolveImagePlacement(
        { width: dims.width, height: dims.height },
        { width: page.width, height: page.height },
        pending.point,
      );
      const bounds = makeBounds(0, 0, placement.width, placement.height);
      const id =
        pending.kind === "image"
          ? actions.addImage(placement.position, dataUrl, dims.width, dims.height, {
              localBounds: bounds,
            })
          : actions.addSignature(
              placement.position,
              dataUrl,
              dims.width,
              dims.height,
              "Signer",
              { localBounds: bounds },
            );
      insertionComplete();
      // Select what was just inserted, so the contextual controls and the
      // inspector are immediately about the new object.
      actions.select(id);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "The selected image could not be loaded.");
    }
  };

  const bgImage = backgroundImageForPage?.(activePage.id);
  const editingObj = editingTextId ? getActivePage(service.getState()).objects[editingTextId] : null;
  const committedEditingText = editingObj && isObjectKind(editingObj, "text") ? editingObj : null;
  /**
   * The object the inline editor is over: a not-yet-committed draft from the text
   * tool, or a committed object opened by double-click / the "Edit" action. The
   * draft takes precedence because only one editor is ever open.
   */
  const editingTextObj = textDraftObject?.object ?? committedEditingText;
  const editingRect = editingTextObj ? textScreenRect(editingTextObj, viewport, origin) : null;

  return (
    <div
      ref={canvasContainerRef}
      tabIndex={cropSessionActive ? 0 : -1}
      aria-describedby={cropSessionActive ? "crop-editor-instructions" : undefined}
      className="relative h-full w-full overflow-hidden bg-editor-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent"
      style={{
        cursor: panning
          ? "grabbing"
          : tool === "hand" || spaceDown
            ? "grab"
            : tool === "select"
              ? "default"
              : "crosshair",
      }}
    >
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onLostPointerCapture}
        onLostPointerCapture={onLostPointerCapture}
        onPointerLeave={() => publishCoords(null)}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={onContextMenuEvent}
        role="application"
        aria-label="PDF editor canvas"
      >
        {/*
          The page's elevation (P1 Phase E2). An SVG filter rather than a CSS
          box-shadow because the page rect lives inside the rotating surface
          group — a CSS shadow would need a second, separately-rotated element
          to stay under it.

          Two layers, matching the `shadow-page` token's intent: a tight contact
          shadow that reads as "resting on the surface", and a wide soft one that
          lifts the page off the application background. The old presentation was
          a single 18%-alpha slate STROKE, which reads as a drawn outline (a
          cutting line) rather than a document sitting on a desk.
        */}
        <defs>
          <filter id="pdfdadi-page-shadow" x="-8%" y="-8%" width="116%" height="116%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#101828" floodOpacity="0.10" />
            <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="#101828" floodOpacity="0.08" />
          </filter>
        </defs>

        {/* The whole page surface — background, objects, selection chrome —
            rotates together for a rotated page (M6). Inner positioning code is
            unchanged; the group conjugates the rotation into screen space. */}
        <g transform={surfaceTransform}>
        {/*
          Page background. The shadow is painted by a dedicated rect UNDER the
          content: applying the filter to the page rect itself would also blur
          the raster page image drawn on top of it.
        */}
        <rect
          x={origin.x}
          y={origin.y}
          width={activePage.width * viewport.zoom}
          height={activePage.height * viewport.zoom}
          fill="#ffffff"
          filter="url(#pdfdadi-page-shadow)"
        />
        <rect
          x={origin.x}
          y={origin.y}
          width={activePage.width * viewport.zoom}
          height={activePage.height * viewport.zoom}
          fill={bgImage ? "none" : "#ffffff"}
          // A hairline cool-neutral edge, not a dark outline: at 8% the border
          // defines the page's boundary against a white-ish canvas without
          // competing with the document's own content.
          stroke="rgba(16,24,40,0.08)"
          strokeWidth={1}
          rx={2}
        />
        {bgImage ? (
          <image
            href={bgImage}
            x={origin.x}
            y={origin.y}
            width={activePage.width * viewport.zoom}
            height={activePage.height * viewport.zoom}
            preserveAspectRatio="xMidYMid meet"
          />
        ) : null}

        {/* Objects in paint order (bottom first). */}
        {objects.map((obj) => (
          <g
            key={obj.id}
            transform={objectToSvgMatrix(obj, viewport, origin)}
            opacity={obj.visible ? 1 : 0}
            style={{
              pointerEvents: obj.visible && !obj.locked && tool === "select" ? "auto" : "none",
              cursor: tool === "select" ? "move" : "crosshair",
            }}
            onPointerDown={(e) => onObjectPointerDown(e, obj)}
            data-object-id={obj.id}
            role="img"
            aria-label={obj.name}
          >
            {/* Transparent hit rect so the whole bbox is grabbable. */}
            <rect
              x={0}
              y={0}
              width={obj.localBounds.width}
              height={obj.localBounds.height}
              fill="rgba(0,0,0,0)"
              pointerEvents="all"
            />
            <ObjectRenderer obj={obj} />
          </g>
        ))}

        {/* In-progress freehand drawing — rendered with the LIVE brush settings
            (color, width, effective opacity, multiply blend for the highlighter)
            so the preview is a preview and not a black placeholder. */}
        {drawingPoints && drawingPoints.length >= 2 ? (
          <polyline
            points={drawingPoints.map((p) => `${p.x * viewport.zoom + origin.x},${p.y * viewport.zoom + origin.y}`).join(" ")}
            fill="none"
            stroke={editorColorToCss({ ...drawSettings.color, a: 1 })}
            strokeOpacity={effectiveStrokeOpacity(drawSettings)}
            strokeWidth={Math.max(1, drawSettings.width * viewport.zoom)}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={drawSettings.brush === "highlighter" ? { mixBlendMode: "multiply" } : undefined}
            pointerEvents="none"
          />
        ) : null}

        {/* Text tool drag: the area being drawn. Dashed so it reads as a draft
            rather than an existing object. */}
        {textDraft && isTextAreaDrag(textDraft.from, textDraft.to) ? (
          <rect
            x={Math.min(textDraft.from.x, textDraft.to.x) * viewport.zoom + origin.x}
            y={Math.min(textDraft.from.y, textDraft.to.y) * viewport.zoom + origin.y}
            width={Math.abs(textDraft.to.x - textDraft.from.x) * viewport.zoom}
            height={Math.abs(textDraft.to.y - textDraft.from.y) * viewport.zoom}
            fill={DRAFT_TINT_WEAK}
            stroke={DRAFT}
            strokeWidth={1}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        ) : null}

        {/* In-progress pen path (M6.10): dashed preview + anchors + handles.
            Page-space coordinates under a page→screen matrix; marker sizes are
            divided by zoom so they stay constant on screen. */}
        {tool === "path" && pathState ? (
          <g
            transform={`matrix(${viewport.zoom} 0 0 ${viewport.zoom} ${origin.x} ${origin.y})`}
            pointerEvents="none"
            aria-hidden="true"
          >
            <path
              ref={pathPreviewRef}
              d={previewPathData(pathState)}
              fill="none"
              stroke={DRAFT}
              strokeWidth={1.5 / viewport.zoom}
              strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
            />
            {pathState.anchors.map((a, i) => (
              <g key={i}>
                {a.handleOut ? (
                  <>
                    <line
                      x1={a.point.x}
                      y1={a.point.y}
                      x2={a.handleOut.x}
                      y2={a.handleOut.y}
                      stroke={DRAFT}
                      strokeWidth={1 / viewport.zoom}
                    />
                    <circle cx={a.handleOut.x} cy={a.handleOut.y} r={3 / viewport.zoom} fill={DRAFT} />
                  </>
                ) : null}
                <circle
                  cx={a.point.x}
                  cy={a.point.y}
                  r={(i === 0 ? 4 : 3.5) / viewport.zoom}
                  fill="#ffffff"
                  stroke={DRAFT}
                  strokeWidth={1.5 / viewport.zoom}
                />
              </g>
            ))}
          </g>
        ) : null}

        {/* In-progress box gesture (shape / highlight). Drawn from the SAME pure
            helper the commit uses, so the preview is a promise: the rectangle
            shown is exactly the object that will be created — including the page
            clamp and the minimum-extent floor. Dashed + accent-tinted so it
            reads as a draft rather than a finished object. */}
        {shapeDraft ? (() => {
          const b = shapeDragBounds(shapeDraft.from, shapeDraft.to, {
            width: activePage.width,
            height: activePage.height,
          });
          const dragging = isShapeDrag(shapeDraft.from, shapeDraft.to);
          return (
            <rect
              data-shape-draft="true"
              x={b.x * viewport.zoom + origin.x}
              y={b.y * viewport.zoom + origin.y}
              width={b.width * viewport.zoom}
              height={b.height * viewport.zoom}
              fill={DRAFT_TINT}
              stroke={DRAFT}
              strokeWidth={1.5}
              strokeDasharray="5 3"
              // Below the drag threshold the gesture will place a default-size
              // shape instead, so a nearly-still pointer shows no misleading
              // hairline box.
              opacity={dragging ? 1 : 0}
              pointerEvents="none"
              aria-hidden="true"
            />
          );
        })() : null}

        {/* Selection chrome + marquee + snap guides. */}
        <SelectionOverlay
          selectionBounds={selection.bounds}
          viewport={viewport}
          origin={origin}
          marquee={marquee}
          snapGuides={snapGuides}
          showRotateHandle={selection.ids.length === 1}
          affordance={affordanceWhileEditing(selectionAffordance, textEditorOpen)}
          onHandlePointerDown={onHandlePointerDown}
        />

        {/* Crop mode overlay (M6.11): ghosted full image + draft window. */}
        {tool === "crop" && cropTarget && cropDraft ? (
          <CropOverlay
            obj={cropTarget}
            draft={cropDraft}
            viewport={viewport}
            origin={origin}
            toPage={toPage}
            onDraftChange={setCropDraft}
          />
        ) : null}
        </g>

        {/* Eraser cursor circle (M6.9): screen-space, sized to the actual hit
            radius, positioned via direct attribute writes on pointer move. */}
        {tool === "eraser" ? (
          <circle
            ref={eraserCircleRef}
            r={DEFAULT_ERASER_RADIUS}
            fill="rgba(15,23,42,0.06)"
            stroke="rgba(15,23,42,0.5)"
            strokeWidth={1}
            opacity={0}
            pointerEvents="none"
            aria-hidden="true"
          />
        ) : null}
      </svg>

      {imageError ? (
        <div
          role="alert"
          className="absolute left-1/2 top-3 z-20 max-w-md -translate-x-1/2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-red-700 shadow-md"
        >
          {imageError}
        </div>
      ) : null}

      {/* Inline text editor overlay. The wrapper applies the same page-surface
          rotation as the SVG group (CSS matrix() shares the coefficient order),
          so the editor lands on the object's displayed position; the inner
          zero-size div restores pointer events for the textarea only. */}
      {editingTextObj && editingRect ? (
        <div
          className="absolute inset-0"
          style={{
            pointerEvents: "none",
            transform: surfaceTransform,
            transformOrigin: "0 0",
          }}
        >
          <div style={{ pointerEvents: "auto", position: "absolute", left: 0, top: 0 }}>
            <TextEditor
              rect={editingRect}
              obj={editingTextObj}
              zoom={viewport.zoom}
              entry={textDraftObject ? "fresh" : editingEntry}
              onCommit={(text) => leaveTextEditor("commit", text)}
              onCancel={() => leaveTextEditor("cancel", "")}
              onUncommittedChange={onUncommittedInputChange}
            />
          </div>
        </div>
      ) : null}

      {/* Crop mode action bar (M6.11): the touch/mouse alternative to
          Enter/Escape, with WCAG-sized targets. */}
      {tool === "crop" && cropTarget && cropDraft ? (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 shadow-md">
          <span id="crop-editor-instructions" className="sr-only">
            Crop editor. Drag the crop window or handles. Arrow keys move it, Shift plus arrows moves ten pixels, Enter applies, Escape cancels, and Delete resets.
          </span>
          <span aria-live="polite" className="text-xs text-slate-600">
            Crop {Math.round(cropDraft.width)} × {Math.round(cropDraft.height)} px
          </span>
          <button
            type="button"
            className="min-h-11 rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            onClick={commitCrop}
          >
            Apply (Enter)
          </button>
          <button
            type="button"
            className="min-h-11 rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            onClick={cancelCrop}
          >
            Cancel (Esc)
          </button>
        </div>
      ) : null}

      {/* The floating contextual object toolbar (P1 Phase G).
          Hidden while a gesture is in flight or the inline text editor is open:
          a bar that follows a dragging object competes with the drag, and one
          floating over an open editor covers the text being typed.
          Gated on `gestureActive` (state), never on `gestureRef` — a render-time
          ref read only appears to work here, via an unrelated incidental render.
          See the setGesture comment. */}
      {objectToolbar && objectToolbar.actions.length > 0 && selection.bounds && !textEditorOpen
        && !gestureActive && !panning && !cropSessionActive ? (
        <ObjectToolbar
          actions={objectToolbar.actions}
          box={(() => {
            // The selection box in CONTAINER space. `pageBoundsToScreen`'s job,
            // inlined here because the SVG applies `surfaceTransform` to its own
            // group and this HTML layer is not inside that group.
            const tl = pageToScreen(viewport, origin, {
              x: selection.bounds.x,
              y: selection.bounds.y,
            });
            return {
              x: tl.x,
              y: tl.y,
              width: selection.bounds.width * viewport.zoom,
              height: selection.bounds.height * viewport.zoom,
            };
          })()}
          container={{
            width: canvasContainerRef.current?.clientWidth ?? 0,
            height: canvasContainerRef.current?.clientHeight ?? 0,
          }}
          subjectLabel={
            selection.ids.length > 1
              ? `${selection.ids.length} selected objects`
              : selectionAffordance.kind === "source-text"
                ? "original PDF text"
                : selectedObjects[0]?.name
          }
          onAction={(id) => {
            // "Edit" is the canvas's own inline editor — the same one
            // double-click opens. Handled here rather than round-tripping
            // through the workspace, which does not own `editingTextId`.
            if (id === "edit") {
              const target = selectedObjects[0];
              if (target && isObjectKind(target, "text")) {
                openTextEditor(target.id, "existing");
                return;
              }
            }
            objectToolbar.onAction(id);
          }}
          onDismiss={() => canvasContainerRef.current?.focus()}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFileSelected}
        aria-hidden="true"
      />
    </div>
  );
}

function textScreenRect(
  obj: { transform: AffineTransform; localBounds: Bounds },
  viewport: Viewport,
  origin: PageScreenOrigin,
): { x: number; y: number; width: number; height: number } {
  // The text object's world bounds top-left, converted to screen.
  const wb = worldBoundsRect(obj);
  return {
    x: wb.x * viewport.zoom + origin.x,
    y: wb.y * viewport.zoom + origin.y,
    width: wb.width * viewport.zoom,
    height: wb.height * viewport.zoom,
  };
}

/** worldBounds recomputed locally to avoid an extra import dependency in the rect helper. */
function worldBoundsRect(obj: { transform: AffineTransform; localBounds: Bounds }): Bounds {
  const t = obj.transform;
  const { width, height } = obj.localBounds;
  const corners = [
    { x: t.e, y: t.f },
    { x: t.a * width + t.c * 0 + t.e, y: t.b * width + t.d * 0 + t.f },
    { x: t.a * width + t.c * height + t.e, y: t.b * width + t.d * height + t.f },
    { x: t.a * 0 + t.c * height + t.e, y: t.b * 0 + t.d * height + t.f },
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
