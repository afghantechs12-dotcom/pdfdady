"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorProvider, useEditorContext } from "@/components/editor/EditorContext";
import { AsyncStatus } from "@/components/ui/AsyncStatus";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import { EditorCanvas } from "@/components/editor/EditorCanvas";
import { PremiumEditorFrame } from "@/components/editor/PremiumEditorFrame";
import { FloatingCanvasControls } from "@/components/editor/FloatingCanvasControls";
import { DocumentFindBar } from "@/components/editor/search/DocumentFindBar";
import { Rulers } from "@/components/editor/canvas/Rulers";
import { ContextMenu } from "@/components/editor/canvas/ContextMenu";
import { LayersPanel } from "@/components/editor/panels/LayersPanel";
import { HistoryPanel } from "@/components/editor/panels/HistoryPanel";
import { PagesPanel } from "@/components/editor/panels/PagesPanel";
import { EditorInspector } from "@/components/editor/EditorInspector";
import { isDocumentInspectorTab } from "@/components/editor/editorPanelLayout";
import { resolveSelectionAffordance } from "@/components/editor/canvas/selectionAffordances";
import {
  resolveObjectToolbar,
  type ObjectToolbarActionId,
} from "@/components/editor/canvas/objectToolbarActions";
import { resolveCropEligibility } from "@/src/application/editor/tools/cropEligibility";
import { StatusBar } from "@/components/editor/StatusBar";
import { SaveStatusIndicator } from "@/components/editor/persistence/SaveStatusIndicator";
import { RecoveryPromptDialog } from "@/components/editor/persistence/RecoveryPromptDialog";
import { ConflictDialog } from "@/components/editor/persistence/ConflictDialog";
import {
  blockingLimitation,
  describeDuplicateOutcome,
  describeRestoreResult,
  documentNameForCapture,
  duplicateCopyName,
  guestIdentityNotice,
  identifyGuestDocument,
  planDraftRestore,
  secondaryLimitations,
  shouldCaptureDocument,
  shouldProbeAbandonedGuestDraft,
  workspaceSourceReference,
} from "@/components/editor/persistence/editorPersistenceWiring";
import { useDocumentPersistence } from "@/hooks/editor/useDocumentPersistence";
import { restoreBackgrounds } from "@/lib/editor/restoreBackgrounds";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import {
  assembleRestoredBackgrounds,
  captureEditorDocument,
} from "@/src/application/editor/persistence/editorCapture";
import {
  describeWorkspaceDocument,
  type DocumentIdentity,
} from "@/src/application/editor/persistence/documentIdentity";
import {
  describeUnsavedReplace,
  hasUnidentifiedWork,
  nextReplaceFlushStep,
} from "@/src/application/editor/persistence/replaceGuard";
import {
  statusHasPendingWork,
  type SaveStatusView,
} from "@/src/application/editor/persistence/derivedStatus";
import type { ConflictActionId } from "@/src/application/editor/persistence/conflictResolution";
import type { RecoveryActionId } from "@/src/application/editor/persistence/recoveryPrompt";
import type { LoadedDraft } from "@/src/application/editor/persistence/draftRepository";
import { browserIdFactory } from "@/src/infrastructure/persistence/browser/createPersistenceRuntime";
import { EditorPanelDrawer } from "@/components/editor/EditorPanelDrawer";
import { useEditorPanels } from "@/hooks/editor/useEditorPanels";
import { useEditor } from "@/hooks/editor/useEditor";
import { useEditorActions } from "@/hooks/editor/useEditorActions";
import { useShortcuts } from "@/hooks/editor/useShortcuts";
import { editorBreakpoints } from "@/styles/editor";
import { downloadBytes, exportEditorPdf } from "@/lib/editor/exportClient";
import { loadPdfIntoEditor, PdfOpenError, type PdfLoadProgress } from "@/lib/editor/loadPdf";
import {
  WorkspaceDocumentLoadError,
  isAbortError,
  loadWorkspaceDocument,
  type WorkspaceDocumentSource,
} from "@/lib/editor/loadWorkspaceDocument";
import { outputFileName } from "@/lib/workflow/fileNames";
import {
  loadAnnouncement,
  loadErrorFacts,
  phaseForFailure,
  placeholderThumbnailCount,
  pollDelayMs,
  presentLoad,
  presentLoadError,
  shouldKeepPolling,
  type LoadErrorAction,
  type LoadErrorFacts,
  type LoadPhase,
} from "@/components/editor/documentLoadState";
import {
  DocumentLoadingOverlay,
  PagesPanelSkeleton,
} from "@/components/editor/DocumentLoadingOverlay";
import { DocumentErrorPanel } from "@/components/editor/DocumentErrorPanel";
import type { EditorTool } from "@/components/editor/editorTypes";
import { createShapeObject } from "@/src/domain/editor/objectFactories";
import type { ShapeObject } from "@/src/domain/editor/objects";
import { ShapeControls } from "@/components/editor/ShapeControls";
import { isDrawingTool, shapeKindForTool } from "@/components/editor/editorTypes";
import { DrawControls } from "@/components/editor/DrawControls";
import {
  DEFAULT_DRAW_SETTINGS,
  type DrawSettings,
} from "@/src/application/editor/tools/drawSettings";
import { TOOL_LABELS } from "@/components/editor/toolbarLayout";
import type { Viewport } from "@/src/application/editor/coordinates/CoordinateSpace";
import { rotatedPageSize } from "@/src/application/editor/coordinates/PageRotation";
import {
  FIT_PADDING,
  clampZoom,
  fitViewport,
  nextZoomStep,
  prevZoomStep,
  zoomAboutPoint,
  type FitMode,
  type ViewSize,
} from "@/components/editor/viewport/zoom";
import { createPointerSubject, createValueSubject } from "@/components/editor/viewport/pointerSubject";
import { IDLE_INTERACTION, type InteractionStatus } from "@/components/editor/statusBarLogic";
import type { Point } from "@/src/domain/editor/geometry";
import {
  INITIAL_TOOL_SESSION,
  afterInsertion,
  selectTool,
  setPinned,
  type ToolSession,
} from "@/src/application/editor/tools/toolSession";
import {
  Files,
  History as HistoryIcon,
  Layers as LayersIcon,
  PanelLeftClose,
  PanelLeftOpen,
  TriangleAlert,
} from "lucide-react";

/**
 * The premium editor workspace (Milestone 4, extended in M6): the mounting
 * surface that owns the editor instance, the viewport/tool/UI state, the
 * "Open PDF" + export flows, and the layout (toolbar · tabbed left sidebar
 * [Pages | Layers | History] · canvas · properties · status bar). It provides
 * the editor binding to the tree via {@link EditorProvider} and wires the
 * shortcut manager + high-level actions, the sticky fit-zoom controller, and
 * the live pointer-coordinate feed for the status bar.
 *
 * M7 integration: passing `document` mounts the same surface against a real
 * Workspace document, loaded over the authorized content route. Everything else
 * is unchanged — this is one editor used in two places rather than two editors
 * that will drift. With no `document`, the standalone `/editor` behaves exactly
 * as before: a local file-input open, no network, no Workspace.
 */
export interface EditorWorkspaceProps {
  /** A Workspace document to open on mount. Omit for the standalone editor. */
  document?: WorkspaceDocumentSource | null;
  /** Rendered above the toolbar — the workbench uses it for the tab strip. */
  header?: React.ReactNode;
  /** Notified when the document finishes loading, with its version number. */
  onDocumentLoaded?: (info: { versionNumber: number | null; pageCount: number }) => void;
  /**
   * Notified when the editor's dirty state changes, for tab indicators.
   *
   * Derived from the canonical save status, NOT from the undo stack. A tab dot
   * computed from `canUndo` stayed lit after a successful save, which is how a
   * workbench tab could read "Unsaved changes" beside a status bar reading
   * "Saved on this device".
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Rendered beside Retry when a document cannot be shown — the workbench
   * passes its "Back to Workspace" link. Supplied by the caller rather than
   * built here because only the caller knows where "back" is.
   */
  onBack?: React.ReactNode;
  /**
   * Rendered inside the canvas region, over the page. Used by the standalone
   * editor for its first-run state; it sits in the same container as the
   * loading/exporting overlays so it covers the canvas without hiding the
   * toolbar or the shell header above it.
   */
  canvasOverlay?: React.ReactNode;
  /**
   * Assigned on mount so a surrounding shell can drive the surface it wraps.
   * The editor keeps ownership of the file input and the export pipeline —
   * this only exposes the two intents a shell legitimately has.
   */
  handleRef?: React.MutableRefObject<EditorSurfaceHandle | null>;
  /**
   * Reports the locally-opened document. Only meaningful for the standalone
   * editor; a Workspace document reports through `onDocumentLoaded`.
   */
  onLocalDocumentChange?: (info: { fileName: string; hasDocument: boolean }) => void;
  /**
   * The canonical save status, handed to whatever chrome surrounds this editor.
   *
   * This replaced two separate feeds — a completed-export callback and a raw
   * revision counter — which the standalone shell combined into a SECOND save
   * indicator of its own. Two projections of "is my work safe" is one too many:
   * the app bar said "Saved to Workspace" from an upload watermark while the
   * status bar said "Unsaved changes" from the durability watermarks, and both
   * were rendered at once. There is now one {@link SaveStatusView}, computed in
   * `deriveSaveStatus`, and every surface renders it.
   *
   * Null until persistence has a view (server render, or a disabled surface):
   * a shell must show nothing rather than guess.
   *
   * Note what is NOT reported here: exports. Downloading a file is not
   * persistence, and feeding it into this indicator is what made "Saved" mean
   * two different things. The shell reports an export's outcome as an outcome.
   */
  onSaveStatusChange?: (status: SaveStatusView | null) => void;
  /**
   * The branded app-header region for the shared presentation frame. The
   * standalone shell passes its own header (and any save banner) here so the
   * whole editor surface is one frame; the workbench keeps its chrome outside.
   */
  appHeader?: React.ReactNode;
  /**
   * Renders the document inspector (outline / comments / versions) inside the
   * shared right-panel machinery — docked where the width affords it, drawer
   * over the canvas otherwise. The helpers are the narrow surface contract that
   * lets outline navigation drive the canvas without reaching into engine
   * internals: `currentPage` (1-based) and `goToPage(page)` for outline jumps.
   * Standalone callers omit this and get no document panel at all.
   */
  renderDocumentInspector?: (helpers: {
    currentPage: number | null;
    goToPage: (page: number) => void;
    /** Which document tab body to render (the Inspector owns the strip). */
    tab: "outline" | "comments" | "versions";
  }) => React.ReactNode;
}

/** The page-navigation surface contract an embedded inspector consumes. */
export interface DocumentInspectorBridge {
  /** The page currently in view, 1-based, or null before a document is active. */
  currentPage: number | null;
  /** Jumps the editor to a 1-based page number. */
  goToPage: (page: number) => void;
  /** The document tab the Inspector currently has selected. */
  tab: "outline" | "comments" | "versions";
}

/** The intents a surrounding shell can trigger on the editor surface. */
export interface EditorSurfaceHandle {
  /** Opens the local file picker (standalone editor only). */
  openPdf: () => void;
  /**
   * Opens a PDF the shell already holds, with no file picker and no upload.
   *
   * This is the receiving end of a tool → editor handoff: the bytes are already in
   * the browser, so they go straight into the editor. Nothing is sent to a server
   * on this path.
   */
  openFile: (file: File) => Promise<void>;
  /**
   * Renders the current document to PDF bytes, as Export would, together with
   * everything a Workspace version needs to be REOPENED as this editing session:
   * the serialized scene, the original source bytes those objects sit on, and the
   * editor revision all three are of.
   *
   * The four are returned together rather than read separately BECAUSE a Workspace
   * commit is a round trip: the user keeps editing while it is in flight, so
   * anything read when the response lands is not what was published. One
   * synchronous read of the scene, taken in the same tick as the revision, is what
   * makes "this version contains this revision" true rather than approximately
   * true — a scene serialized after the export would be a different document than
   * the bytes published beside it.
   */
  exportBytes: () => Promise<{
    bytes: Uint8Array;
    revision: number;
    /** `actions.serialize()` — the canonical envelope, not a hand-built shape. */
    scene: SerializedEditorState;
    /** The bytes the scene is drawn on top of, or null for a document with none. */
    sourceBytes: Uint8Array | null;
  }>;
  /**
   * Tells the canonical persistence machine that an explicit Workspace version
   * commit succeeded, for the revision that was exported and the version the server
   * published. Only a real 2xx commit may call it.
   */
  noteVersionCommitted: (input: {
    revision: number;
    serverVersion: number | null;
    /** The document revision the commit produced — the next fencing token. */
    documentRevision?: number | null;
    etag: string | null;
  }) => void;
  /**
   * Renames the document. The name becomes the export filename stem, so the
   * caller is expected to have sanitised it (`sanitizeDocumentName`); this only
   * stores it.
   */
  rename: (name: string) => void;
  /**
   * Adopts the blank page already on screen as the visitor's document, so it is
   * protected like any other.
   *
   * The standalone shell's "Create blank PDF" loads nothing — the editor's default
   * A4 page IS the document and only the onboarding overlay is dismissed — so
   * there is no load path to arm persistence from. Without this call that surface
   * is the one place a user can work for an hour with no draft behind them.
   */
  startBlankDocument: () => void;
}

export function EditorWorkspace(props: EditorWorkspaceProps = {}) {
  const editor = useEditor();
  return (
    <EditorProvider editor={editor}>
      <EditorWorkspaceInner {...props} />
    </EditorProvider>
  );
}

type SidebarTab = "pages" | "layers" | "history";

const SIDEBAR_TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "pages", label: "Pages" },
  { id: "layers", label: "Layers" },
  { id: "history", label: "History" },
];

/**
 * Where the left rail's expanded/collapsed preference lives.
 *
 * Namespaced under `pdfdadi.editor.` like the panel preferences in
 * `useEditorPanels`, and deliberately a plain string ("open"/"closed") rather
 * than JSON: a corrupted value can only fail closed to the default, never throw
 * during render.
 */
const LEFT_RAIL_STORAGE_KEY = "pdfdadi.editor.leftRail";

function EditorWorkspaceInner({
  document: source = null,
  header,
  onDocumentLoaded,
  onDirtyChange,
  onBack,
  canvasOverlay,
  handleRef,
  onLocalDocumentChange,
  onSaveStatusChange,
  appHeader,
  renderDocumentInspector,
}: EditorWorkspaceProps) {
  const {
    state,
    activePage,
    actions,
    selection,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    revision,
    // The service, for its LIVE revision. Every persistence callback here is async,
    // and `revision` in a closure is the value at the render the callback was made
    // in — handing that to the coordinator after an await would baseline the document
    // at a revision the user has already edited past, and the edits in between would
    // never be persisted.
    service,
  } = useEditorContext();
  /**
   * The armed tool AND whether the user pinned it. One state, because "which
   * tool" and "does it stay after use" are one decision the whole shell reads:
   * the toolbar's indicator, the status readout, and the canvas's
   * after-insertion behaviour all derive from it. See `toolSession` for the
   * one-shot/pinned/continuous policy.
   */
  const [toolSession, setToolSession] = useState<ToolSession>(INITIAL_TOOL_SESSION);
  const tool = toolSession.active;
  const setTool = useCallback(
    (next: EditorTool) => setToolSession((session) => selectTool(session, next)),
    [],
  );
  /**
   * What the canvas calls when a one-shot tool finishes creating something —
   * replacing eight hard-coded `onToolChange("select")` calls with the single
   * policy, so a pinned tool actually stays armed.
   */
  const completeInsertion = useCallback(() => setToolSession(afterInsertion), []);
  const setToolPinned = useCallback(
    (pinned: boolean) => setToolSession((session) => setPinned(session, pinned)),
    [],
  );
  /**
   * The Draw tool's live settings. Owned here (not in the canvas) so the
   * contextual controls under the toolbar and the stroke being drawn read the
   * same state, and so the choice survives switching to Select and back.
   */
  const [eraserRadius, setEraserRadius] = useState(16);
  const [shapeDefaults, setShapeDefaults] = useState<Partial<Record<EditorTool, ShapeObject>>>({});
  const shapeKind = shapeKindForTool(tool);
  const shapeTemplate = useMemo(() => shapeKind ? shapeDefaults[tool] ?? createShapeObject({ x: 0, y: 0 }, "preview", shapeKind) : null, [shapeKind, shapeDefaults, tool]);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>(DEFAULT_DRAW_SETTINGS);
  const [viewport, setViewport] = useState<Viewport>({ zoom: 1, pan: { x: 48, y: 48 } });
  const [fitMode, setFitMode] = useState<FitMode | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("pages");
  /**
   * Whether the left rail is expanded (spec: collapsible left panel).
   *
   * Read from localStorage on mount rather than in the initialiser: the editor
   * renders on the server too, and touching `window` during the first render
   * would hydrate a different tree than the server produced. `true` is the
   * pre-existing behaviour, so a user with no stored preference sees no change.
   */
  const [focusCanvas, setFocusCanvas] = useState(false);
  const changeFocusCanvas = useCallback((focused: boolean) => {
    setFocusCanvas(focused);
    try { window.localStorage.setItem("pdfdadi.editor.focusCanvas", String(focused)); } catch { /* optional preference */ }
  }, []);
  useEffect(() => { try { setFocusCanvas(window.localStorage.getItem("pdfdadi.editor.focusCanvas") === "true"); } catch { /* optional preference */ } }, []);
  const [leftRailOpen, setLeftRailOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LEFT_RAIL_STORAGE_KEY);
      if (stored === "closed") setLeftRailOpen(false);
    } catch {
      // A blocked/full localStorage is not a reason to fail to render an editor.
    }
  }, []);
  const toggleLeftRail = useCallback((open: boolean) => {
    setLeftRailOpen(open);
    try {
      window.localStorage.setItem(LEFT_RAIL_STORAGE_KEY, open ? "open" : "closed");
    } catch {
      /* preference is best-effort */
    }
  }, []);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [backgrounds, setBackgrounds] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const openingRef = useRef(false);
  const [openingFileName, setOpeningFileName] = useState("");
  const [localLoad, setLocalLoad] = useState<PdfLoadProgress>({ phase: "reading" });
  // The Workspace document load, as an explicit machine. `loading` above stays
  // for the standalone editor's local file-open path, which has no network,
  // no preparation state and nothing to poll.
  const [phase, setPhase] = useState<LoadPhase>("idle");
  /**
   * Failure EVIDENCE, not a message.
   *
   * The shipped build stored the server's string here and rendered it, which is
   * how ingestion diagnostics ("The stored bytes do not match the uploaded
   * checksum") reached the panel. Storing facts instead means the copy is
   * authored by `presentLoadError` and the diagnostic goes to the console.
   */
  const [loadError, setLoadError] = useState<LoadErrorFacts | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Whether the in-document find bar (Ctrl+F) is open. */
  const [findOpen, setFindOpen] = useState(false);
  // In place rather than through alert(): a blocking dialog steals focus from
  // the canvas, cannot be read back in context, and has to be dismissed before
  // the user can even look at what failed.
  const [notice, setNotice] = useState<string | null>(null);
  const [fileName, setFileName] = useState("document");
  const sourceBytesRef = useRef<Uint8Array | null>(null);
  const openPdfInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<SidebarTab, HTMLButtonElement>());
  const pointerSubjectRef = useRef(createPointerSubject());
  const interactionSubjectRef = useRef(createValueSubject<InteractionStatus>(IDLE_INTERACTION));

  // --- Document persistence: autosave, recovery, conflict --------------------
  /**
   * Which kind of surface this is, decided from the props and never from
   * {@link identity}.
   *
   * The runtime is built on the first render, when no document has loaded and the
   * identity is still null. Inferring "guest" from that would give a Workspace
   * editor a guest runtime — local drafts only, no cloud transport, and nothing
   * anywhere reporting that the workspace was never being written to.
   */
  const origin: "guest" | "workspace" = source ? "workspace" : "guest";
  /**
   * The document being protected, or null while there is nothing to protect.
   *
   * SET LAST ON EVERY LOAD PATH, after the content is already in the editor.
   * Opening a document arms the write scheduler, and `captureEditorDocument`
   * happily serialises the editor's default blank page — so an identity set before
   * its content landed would commit one blank page as this document's draft, and
   * the next crash would offer to "recover" that over the user's real work.
   */
  const [identity, setIdentity] = useState<DocumentIdentity | null>(null);
  /**
   * Which document's content is ACTUALLY on screen. A ref, not state.
   *
   * This is the capture interlock. State is a render behind: a switch between
   * documents replaces the content and the identity in the same tick, and the write
   * scheduler's timer can fire in between. Comparing this against the open identity
   * turns every crossover into a SKIPPED write instead of a wrong one — the
   * coordinator reads a null capture as "nothing to write yet" and asks again on the
   * next mutation, so refusing costs nothing and guessing costs the document.
   */
  const loadedKeyRef = useRef<string | null>(null);
  /** False when this tab could not remember the guest document's id. Surfaced, not hidden. */
  const [guestIdentityPersisted, setGuestIdentityPersisted] = useState(true);
  /**
   * The document RECORD REVISION the content on screen came from — the
   * compare-and-swap token every write is fenced against, not the version number
   * the user is shown.
   *
   * They are different counters that look alike: a rename, a favourite or a move
   * advances the revision and creates no version, so after one rename a tab holding
   * the version number would fence against a value the server passed long ago. Null
   * until a load discloses one, which means "read it before writing".
   */
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  /** Built once, lazily, because it reads `window`. */
  const newIdRef = useRef<(() => string) | null>(null);
  const nextId = () => {
    if (newIdRef.current === null) {
      newIdRef.current = browserIdFactory(window as unknown as Record<string, unknown>);
    }
    return newIdRef.current();
  };

  /*
   * ONE SYNCHRONOUS READ of the whole document, or null. It must never await: the
   * scheduler stamps the write with the revision it read before calling this, so a
   * capture that yielded would file the document under a revision the user has
   * already edited past.
   *
   * Not memoised, equally deliberately. The hook re-registers this on every render
   * so the scheduler always serialises what is on screen NOW; a `useCallback` here
   * would freeze the closure for as long as its dependencies held and then autosave
   * a stale document while reporting the write as durable.
   */
  const capture = () => {
    if (
      !shouldCaptureDocument({
        loadedKey: loadedKeyRef.current,
        openKey: identity?.documentKey ?? null,
      })
    ) {
      return null;
    }
    return captureEditorDocument({
      scene: actions.serialize(),
      state,
      sourceBytes: sourceBytesRef.current,
      sourceReference: source
        ? workspaceSourceReference({
            workspaceId: source.workspaceId,
            documentId: source.documentId,
            versionNumber: source.versionNumber ?? null,
          })
        : null,
      documentName: documentNameForCapture(fileName),
    });
  };

  const persistence = useDocumentPersistence({
    origin,
    identity,
    revision,
    capture,
    serverVersion,
    /*
     * The workspace content route does not return an ETag, so there is none to
     * send and claiming one would be a fabricated precondition. The version number
     * carries the same guarantee and is what the conflict check compares.
     */
    etag: null,
  });
  /** For the effects and async handlers, which must not read a stale render. */
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  /** The outgoing document's name, for a message written after the awaits. */
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;

  /**
   * Saves the document that is about to be REPLACED, and answers whether it worked.
   *
   * Every load path ends in `actions.loadState`, which destroys what is on screen,
   * and this is the only thing between that and the user's unsaved work. It used to
   * be a bare `await persistence.saveNow()` whose verdict was thrown away — see
   * {@link nextReplaceFlushStep} for the four ways that resolves without the work
   * being safe, the widest of which is a re-queued retry that the replace's
   * `closeDocument` then discards while the status bar still offers it.
   *
   * The verdict comes from `canNavigate()` rather than from the flush result, and it
   * is read AFTER each await from the binding rather than from a render, because the
   * render that started the await predates the answer. Bounded by
   * {@link REPLACE_FLUSH_ATTEMPTS}: a user who keeps typing must not hold the load
   * open, and an unwritable store never becomes durable however often it is asked.
   *
   * Returns the message to show, or null when there is nothing to report. It never
   * refuses the replace — the user asked for the other document, and an editor stuck
   * on the previous one while the URL names the new one is its own defect. What it
   * guarantees is that the destruction is not SILENT.
   */
  const flushBeforeReplace = async (): Promise<string | null> => {
    const documentName = fileNameRef.current;
    if (identityRef.current === null) {
      /*
       * Nothing open: nothing to flush, and nowhere to flush it to. Correct for an
       * ordinary first load — and a loss the moment the user has put something on
       * the blank page while their document was still being fetched, which a paste
       * can do through a window listener no loading overlay covers.
       */
      const pages = Object.values(service.getState().document.pages);
      const objectCount = pages.reduce(
        (total, page) => total + Object.keys(page.objects).length,
        0,
      );
      return hasUnidentifiedWork({ identityPresent: false, objectCount })
        ? describeUnsavedReplace({ documentName: null, reason: null })
        : null;
    }
    for (let attemptsSpent = 1; ; attemptsSpent += 1) {
      await persistenceRef.current.saveNow();
      const verdict = persistenceRef.current.canNavigate();
      const step = nextReplaceFlushStep({ decision: verdict.decision, attemptsSpent });
      if (step === "replace") return null;
      if (step === "warn_and_replace") {
        return describeUnsavedReplace({ documentName, reason: verdict.reason });
      }
    }
  };
  /** For the load effect, whose closure must not pin an older render's names. */
  const flushBeforeReplaceRef = useRef(flushBeforeReplace);
  flushBeforeReplaceRef.current = flushBeforeReplace;

  /**
   * Good news about the document, kept apart from `notice`.
   *
   * `notice` is styled as a failure, and it should be: everything else that uses it
   * is one. "Your unsaved work is back" rendered in the same red band would read as
   * a problem, and a user who has just been handed their work back should not have
   * to decide whether the message means it worked.
   */
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  /**
   * Which standing conflict the user has closed the dialog on.
   *
   * Closing is not resolving. The conflict stays in the coordinator's view and the
   * save-status readout keeps offering "Resolve", because a conflict that vanished
   * when dismissed would leave this tab quietly diverged from the workspace with
   * nothing on screen saying so. Keyed on the conflict itself, so a NEW one — the
   * server moved again — raises the dialog again.
   */
  const [conflictClosedKey, setConflictClosedKey] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  /** Whether the abandoned-guest-draft probe has already run for this mount. */
  const probedRef = useRef(false);

  const handlers = useEditorActions();
  // Whether a workspace document backs this editor decides the Inspector's tab
  // set: standalone gets Properties alone rather than three tabs that would each
  // only explain their own emptiness.
  const panels = useEditorPanels(Boolean(renderDocumentInspector));

  // --- Compact presentation from the REAL container width --------------------
  // The floating control capsule and the status bar's reduced readouts are
  // driven by the editor's own width, not a viewport breakpoint: inside the
  // workbench the editor sits beside the AppShell sidebar, so a 1024px window
  // does not give the editor 1024px.
  const frameRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setCompact(el.clientWidth < editorBreakpoints.floatingControls);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- Canvas host measurement (real fit modes need the real container size) --
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [hostSize, setHostSize] = useState<ViewSize | null>(null);
  useEffect(() => {
    const el = canvasHostRef.current;
    if (!el) return;
    const update = () => setHostSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The displayed page extent: page rotation swaps width/height at 90/270.
  const displaySize = rotatedPageSize(activePage.rotation, {
    width: activePage.width,
    height: activePage.height,
  });

  // Sticky fit: recompute on container resize, page switch, page resize, or
  // page rotation — until the user zooms manually (which clears fitMode).
  //
  // `fitViewport` reserves the floating capsule's strip at the canvas bottom, so
  // Fit Page leaves the page clear of the bar instead of tucking its last 66px
  // underneath it (measured on the pre-Phase-I build).
  useEffect(() => {
    if (!fitMode || !hostSize) return;
    setViewport(fitViewport(fitMode, hostSize, displaySize, FIT_PADDING));
    // displaySize is derived per render; its primitives are the real deps.
  }, [fitMode, hostSize, displaySize.width, displaySize.height, activePage.id]);

  // --- Zoom intents ----------------------------------------------------------
  /** A manual zoom: clears the sticky fit and rezooms about the view center. */
  const applyManualZoom = (zoom: number) => {
    setFitMode(null);
    const z = clampZoom(zoom);
    setViewport((v) =>
      hostSize ? zoomAboutPoint(v, { x: hostSize.width / 2, y: hostSize.height / 2 }, z) : { ...v, zoom: z },
    );
  };
  const zoomIn = () => applyManualZoom(nextZoomStep(viewport.zoom));
  const zoomOut = () => applyManualZoom(prevZoomStep(viewport.zoom));

  /** Canvas viewport changes: a zoom change (ctrl+wheel) breaks the fit; pure pans keep it. */
  const onCanvasViewportChange = (v: Viewport) => {
    if (v.zoom !== viewport.zoom) setFitMode(null);
    setViewport(v);
  };

  // --- Page navigation -------------------------------------------------------
  const pages = state.document.pages;
  const activeIndex = pages.findIndex((p) => p.id === activePage.id);
  const goToPage = (index: number) => {
    const page = pages[Math.max(0, Math.min(index, pages.length - 1))];
    if (page && page.id !== activePage.id) actions.setActivePage(page.id);
  };

  // The narrow page-navigation surface contract for an embedded inspector
  // (outline entries jump the canvas; the inspector shows the live page). The
  // tab travels with it: the Inspector owns the single flat strip, so the
  // workspace panel renders only the body that strip has selected.
  const documentTab = isDocumentInspectorTab(panels.activeTab)
    ? (panels.activeTab as "outline" | "comments" | "versions")
    : "outline";
  const documentInspectorBridge: DocumentInspectorBridge = {
    currentPage: activeIndex >= 0 ? activeIndex + 1 : null,
    goToPage: (page) => goToPage(page - 1),
    tab: documentTab,
  };
  // Rendered once per layout pass — React reconciles, so the inspector's own
  // lazy-loading state survives tab switches within the panel.
  const documentInspectorNode = renderDocumentInspector
    ? renderDocumentInspector(documentInspectorBridge)
    : null;

  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const bytes = await exportEditorPdf(state, sourceBytesRef.current ?? undefined);
      downloadBytes(bytes, outputFileName({ fallbackBase: fileName, suffix: "edited", ext: "pdf" }));
      // Nothing is reported to the save indicator, deliberately. An export is a
      // copy the user now holds; it does not make the document durable, and the
      // shell used to turn it into "Exported — no edits since" in the same app
      // bar that the persistence readout was calling unsaved.
    } catch (err) {
      console.error("Export failed", err);
      setNotice("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const onSave = () => {
    const data = JSON.stringify(actions.serialize(), null, 2);
    downloadBytes(new TextEncoder().encode(data), `${fileName}.pdfdadi.json`, "application/json");
  };

  const onOpenPdf = () => openPdfInputRef.current?.click();
  /** Set after `openFile` is declared; read by the handle assigned during render. */
  const openFileRef = useRef<(file: File) => Promise<void>>(async () => {});

  /**
   * Arms persistence for the blank page the editor already holds.
   *
   * Everything the file-open path does about identity, in the same order, minus the
   * content: there is nothing to load, so the interlock and what is on screen agree
   * before this runs. Synchronous throughout — no await between the interlock and
   * the identity — and it refuses when a document is already open, because it is
   * reachable from a shell rather than from a load and must not re-identify the
   * document a user is working in.
   *
   * The fingerprint has no bytes to sample, so it is derived from the name alone.
   * That is deliberate: clicking "Create blank PDF" again in the same tab resolves
   * to the same guest id and continues the draft it left, which is the same
   * continuation reopening a file gets.
   */
  const startBlankDocument = () => {
    /*
     * Refused only when content is actually on screen — NOT merely because an
     * identity exists.
     *
     * An identity with no content is a real state, and it is the state the
     * abandoned-draft probe leaves behind: it opens a draft it found as this tab's
     * identity so the recovery offer can be raised, without loading anything. Once
     * the user answers that offer by dismissing or deleting it, `loadedKeyRef` is
     * still null, so the capture interlock refuses every capture — and refusing on
     * `identity` here meant "Create blank PDF" could not repair it either. The
     * editor stayed usable and saved NOTHING for the rest of the mount, reporting
     * "Unsaved changes — your most recent edits are not stored anywhere yet"
     * truthfully and permanently. Verified in a production build, then covered by
     * phase 6 of `editor-persistence-probe.mjs`.
     *
     * `loadedKeyRef` is the right test because every path that puts content on
     * screen sets it: this one, opening a file, opening a workspace version, and
     * restoring a draft. So a real document is still protected from being replaced,
     * and the probe-armed state is no longer a dead end.
     */
    if (loadedKeyRef.current !== null) return;
    /*
     * Re-keyed when an identity is already open, because that identity can only have
     * come from the probe, and its draft is the one the user just declined. Reusing
     * its key would advance that draft's pointer past their work on the next
     * autosave. A fresh id leaves the declined draft untouched and still findable.
     */
    const identified = identifyGuestDocument({
      fileName,
      bytes: null,
      scope: window,
      newId: nextId,
      forceNewIdentity: identityRef.current !== null,
    });
    loadedKeyRef.current = identified.identity.documentKey;
    setPersistenceNotice(null);
    setServerVersion(null);
    setGuestIdentityPersisted(identified.persisted);
    setIdentity(identified.identity);
  };

  // The shell's handle. Assigned during render (not in an effect) so a shell
  // that renders above this component can dispatch on its very first paint
  // without a one-frame window where its buttons do nothing.
  if (handleRef) {
    handleRef.current = {
      openPdf: onOpenPdf,
      // Through a ref because `openFile` is declared below this assignment (which
      // happens during render, so the shell's first paint already has a handle).
      openFile: (file) => openFileRef.current(file),
      exportBytes: async () => {
        /*
         * The PERSISTENCE revision, read BEFORE the export awaits.
         *
         * Not `revision` from `useEditorContext` — that is `CommandHistory.revision`,
         * a different counter in a different domain (see `RevisionBridge`: it
         * restarts per mount, advances on loads, and advances per frame). The machine
         * compares what it is given against `state.currentRevision`, so this is the
         * only number that may be handed to `noteVersionCommitted`. Read at issuance,
         * because the user goes on editing while the commit is in flight.
         */
        // `view` is null only on a surface where persistence is disabled, and such a
        // surface has no machine to tell: `noteVersionCommitted` below is a no-op
        // there, so the fallback number never reaches a reducer.
        const revision = persistenceRef.current.view?.state.currentRevision ?? -1;
        /*
         * Read in the SAME TICK as the revision and before the export awaits, for
         * the same reason capture is synchronous: anything read after an await is a
         * document the user may already have edited past, and a version whose scene
         * and bytes disagree is exactly the fidelity defect this phase exists to
         * remove.
         */
        const scene = actions.serialize();
        const sourceBytes = sourceBytesRef.current;
        return {
          bytes: await exportEditorPdf(state, sourceBytes ?? undefined),
          revision,
          scene,
          sourceBytes,
        };
      },
      noteVersionCommitted: (committed) =>
        persistenceRef.current.noteVersionCommitted(committed),
      rename: (name) => setFileName(name),
      startBlankDocument,
    };
  }

  /**
   * Opens a PDF that already exists as a `File`, whatever produced it.
   *
   * Extracted from the picker's change handler so a tool result can be handed
   * STRAIGHT here — the whole point of the workflow handoff is that the user does
   * not download the merge output, find it in their Downloads folder and upload it
   * again. There is one open path, so a handoff cannot drift from a file-picker
   * open: same identity derivation, same draft interlock, same failure copy.
   */
  const openFile = async (file: File) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpeningFileName(file.name);
    setLocalLoad({ phase: "reading" });
    setLoading(true);
    try {
      const loaded = await loadPdfIntoEditor(file, { onProgress: setLocalLoad });
      /*
       * The last moment the OUTGOING document is both open and still on screen, so
       * the last moment a capture of it is correct. `closeDocument` cancels the
       * schedulers rather than flushing them — deliberately, so a close racing a
       * write cannot complete it against a document that is gone — which means
       * anything not yet written when the identity changes is dropped unless it is
       * flushed here. Awaited before the content is replaced, and after
       * `loadPdfIntoEditor` resolved, so a failed open never disturbs the document
       * the user still has.
       */
      const unsaved = await flushBeforeReplace();
      const identified = identifyGuestDocument({
        fileName: file.name,
        bytes: loaded.sourceBytes,
        scope: window,
        newId: nextId,
      });
      /*
       * Synchronous from here to `loadState`: no await between the interlock and the
       * content it describes, so no scheduler timer can observe the two disagreeing.
       */
      loadedKeyRef.current = identified.identity.documentKey;
      actions.loadState(loaded.state);
      setBackgrounds(loaded.backgrounds);
      sourceBytesRef.current = loaded.sourceBytes;
      const openedName = file.name.replace(/\.pdf$/i, "") || "document";
      setFileName(openedName);
      onLocalDocumentChange?.({ fileName: openedName, hasDocument: true });
      setPersistenceNotice(null);
      setServerVersion(null);
      setGuestIdentityPersisted(identified.persisted);
      // After the content is on screen: a banner about the document that just closed
      // must not be what the user reads while wondering whether the open worked.
      if (unsaved !== null) setNotice(unsaved);
      /*
       * Identity LAST. The id is derived from the file itself, so reopening the same
       * file in this tab finds the draft it left behind instead of starting a second,
       * parallel history of the same document.
       */
      setIdentity(identified.identity);
      // Open at fit-page with the Pages rail showing. Pages leads unconditionally
      // now (it used to yield to Layers for single-page documents): thumbnails are
      // how people recognise the document they just opened, and a 1-page PDF is
      // exactly the case where an empty "Layer 1" tree says least.
      setFitMode("fit-page");
      setSidebarTab("pages");
    } catch (err) {
      console.error("Open PDF failed", err);
      /*
       * A NOTICE, not the error panel — deliberately.
       *
       * This is the local file-open path, and the user may already have a
       * document open. Replacing the canvas with a full error panel would hide
       * (and imply the loss of) work that is perfectly intact: the failed open
       * changed nothing. The banner reports the failure and leaves the document
       * alone.
       *
       * Both causes go through the presentation layer, which is where every
       * string a user reads is authored. A page-cap refusal used to bypass it and
       * show `err.message` — actionable here, but the Workspace panel could not
       * read that text and fell back to "the file may be damaged" for the same
       * intact file. Passing the cap NUMBERS instead gives both surfaces the one
       * authored sentence.
       */
      setNotice(
        presentLoadError(
          {
            ...loadErrorFacts(null),
            invalidPdf: true,
            pageCap: err instanceof PdfOpenError ? err.pageCap : null,
          },
          { context: "standalone" },
        ).description,
      );
    } finally {
      openingRef.current = false;
      setLoading(false);
    }
  };

  openFileRef.current = openFile;

  const onOpenPdfFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared before the await so choosing the SAME file again still fires
    // `change` — a user who opens a file, edits, then reopens it to start over.
    e.target.value = "";
    if (!file) return;
    await openFile(file);
  };

  // --- Workspace document loading -------------------------------------------
  // Keyed on the document's identity, not on the object: the workbench rebuilds
  // the source object each render, and depending on it would refetch the PDF on
  // every keystroke. An in-flight load is aborted when the identity changes so a
  // slow first document cannot land after a second one and overwrite it.
  const sourceKey = source
    ? `${source.workspaceId}:${source.documentId}:${source.versionNumber ?? "current"}`
    : null;
  const loadedRef = useRef<string | null>(null);
  const onLoadedRef = useRef(onDocumentLoaded);
  onLoadedRef.current = onDocumentLoaded;
  // Read by the load effect's cleanup, which cannot see current state through
  // its closure but must know whether the load it is tearing down had finished.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Bumped by Retry to re-run the load effect for the same document identity.
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!source || sourceKey === null) return;
    // A completed load is not repeated; a retry clears this first.
    if (loadedRef.current === sourceKey) return;

    const controller = new AbortController();
    let cancelled = false;
    loadedRef.current = sourceKey;

    /** Waits, unless the load was superseded or the editor unmounted. */
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });

    setPhase("loading-content");
    setLoadError(null);
    setTimedOut(false);
    setNotice(null);

    void (async () => {
      const startedAt = Date.now();
      let attempt = 0;

      try {
        // Loops only while the server reports the upload is still being
        // prepared. Every other outcome — success, failure, exhausted budget —
        // leaves the loop, which is what guarantees the spinner ends.
        for (;;) {
          attempt += 1;
          try {
            const loaded = await loadWorkspaceDocument(source, controller.signal);
            if (cancelled) return;

            /*
             * Flush the document being replaced, while it is still open and still on
             * screen — see the same call on the local-open path. Switching tabs in
             * the workbench mounts one editor against a second document, and without
             * this the first document's unwritten draft is cancelled, not saved.
             */
            const unsaved = await flushBeforeReplaceRef.current();
            if (cancelled) return;

            setPhase("initializing-editor");
            const workspaceIdentity = describeWorkspaceDocument({
              workspaceId: source.workspaceId,
              documentId: source.documentId,
              organizationId: source.organizationId,
            });
            // Synchronous through `loadState`/`deserialize`: the interlock and the
            // content it describes are set in one tick.
            loadedKeyRef.current = workspaceIdentity.documentKey;
            /*
             * A version saved from an editing session is reopened AS that session,
             * through the editor's own canonical codec — which owns the format
             * migrations and the plugin object registry, so a note stays a note and
             * a plugin object stays itself. Only versions with no stored scene
             * (every imported one) are seeded from the PDF.
             */
            if (loaded.scene !== null) actions.deserialize(loaded.scene);
            else actions.loadState(loaded.state);
            setBackgrounds(loaded.backgrounds);
            sourceBytesRef.current = loaded.sourceBytes;
            setFileName(source.name.replace(/\.pdf$/i, "") || "document");
            setFitMode("fit-page");
            setSidebarTab("pages");
            setPersistenceNotice(null);
            if (unsaved !== null) setNotice(unsaved);
            // The REVISION the content route disclosed, not `loaded.versionNumber`:
            // this seeds the compare-and-swap, and the version number is only for
            // display. Null when the server named none, which makes the first write
            // read one rather than assert a number nobody reported.
            setServerVersion(loaded.documentRevision);
            // Identity last: opening arms the autosave, and it must not arm over a
            // half-initialised editor.
            setIdentity(workspaceIdentity);
            onLoadedRef.current?.({
              versionNumber: loaded.versionNumber,
              // Read from the service, not from `loaded`: on the scene path the
              // page count only exists after the codec has run.
              pageCount: service.pageCount,
            });
            if (!cancelled) setPhase("ready");
            return;
          } catch (error) {
            if (cancelled || controller.signal.aborted) return;
            // An abort is cancellation, not failure: the load effect aborts when
            // a document's identity changes and StrictMode aborts its first dev
            // pass. Presenting either as an error would put a failure panel over
            // a document that is loading correctly.
            if (isAbortError(error)) return;

            const preparation =
              error instanceof WorkspaceDocumentLoadError ? error.preparation : "none";
            const elapsed = Date.now() - startedAt;
            const canKeepPolling = shouldKeepPolling(attempt, elapsed);
            const next = phaseForFailure({ preparation, canKeepPolling });

            if (next === "processing-upload") {
              // Still being prepared and still within budget: show the honest
              // processing state rather than a bare spinner, then wait.
              setPhase("processing-upload");
              await wait(pollDelayMs(attempt + 1));
              if (cancelled || controller.signal.aborted) return;
              continue;
            }

            // Terminal. A failed identity must not count as loaded, so a retry
            // is possible.
            loadedRef.current = null;
            const exhausted = preparation === "processing" && !canKeepPolling;
            // The diagnostic goes to the console — where a developer can read the
            // server's own words — and the FACTS go to state, where the
            // presentation layer turns them into copy it authored itself.
            console.error("Workspace document load failed", error);
            setTimedOut(exhausted);
            setLoadError(loadErrorFacts(error, { timedOut: exhausted }));
            setPhase("error");
            return;
          }
        }
      } catch (error) {
        // Defensive: nothing above should escape, but a load must never end
        // without a terminal phase.
        if (!cancelled && !isAbortError(error)) {
          loadedRef.current = null;
          console.error("Workspace document load failed", error);
          setLoadError(loadErrorFacts(error));
          setPhase("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // A load torn down before it reached `ready` did not complete, so this
      // identity must not stay marked as loaded. StrictMode's dev double-invoke
      // is the case that matters: it runs this cleanup between the two invokes,
      // and a guard left set makes the second invoke return at the top with the
      // fetch already aborted — phase stranded on "loading-content", which
      // renders a spinner with no retry and nothing left to clear it. The
      // terminal error path clears the guard for the same reason.
      if (loadedRef.current === sourceKey && phaseRef.current !== "ready") {
        loadedRef.current = null;
      }
    };
    // `source` is rebuilt per render; `sourceKey` is its stable identity, and
    // is deliberately the only document dependency — depending on the object
    // itself would refetch the PDF on every parent render. `loadAttempt` is
    // what a manual retry changes.
  }, [sourceKey, loadAttempt]);

  /** Retries a failed or still-preparing load for the same document. */
  const retryLoad = useCallback(() => {
    loadedRef.current = null;
    setTimedOut(false);
    setLoadError(null);
    setLoadAttempt((n) => n + 1);
  }, []);

  // --- Recovery, conflict, and the abandoned-draft probe ---------------------
  /**
   * Work a previous guest tab left behind, after this one reloaded.
   *
   * A refreshed guest tab has no file: no bytes, no fingerprint, and possibly no
   * session identity map, so the ordinary probe inside `openDocument` has no key to
   * look under and the draft sits in IndexedDB — complete, and unreachable. This
   * enumerates the draft index instead and opens the best candidate as this tab's
   * identity WITHOUT loading any content. The open is what raises the recovery
   * offer; the capture interlock is what stops the empty editor from being written
   * over the draft while the offer is unanswered.
   */
  useEffect(() => {
    if (
      !shouldProbeAbandonedGuestDraft({
        origin,
        hasOpenDocument: identityRef.current !== null,
        alreadyProbed: probedRef.current,
      })
    ) {
      return;
    }
    probedRef.current = true;
    let finished = false;
    void (async () => {
      const found = await persistenceRef.current.findAbandonedGuestDraft();
      finished = true;
      // Null is the common answer and must be silent: most tabs have nothing
      // abandoned, and a "nothing to recover" message on every load is how a user
      // learns to ignore the one that matters.
      if (found === null) return;
      setIdentity(found);
    })();
    return () => {
      /*
       * StrictMode's dev double-invoke runs this cleanup between the two invokes. A
       * probe that had not finished must be allowed to run again, or the recovery
       * offer is lost in development only — which is the hardest kind of bug to see,
       * because the production build would be the first place it worked.
       */
      if (!finished) probedRef.current = false;
    };
    // Once per mount for a guest surface. `identity` is deliberately NOT a
    // dependency: re-probing after the user opens a file would offer them a draft
    // from a different document while they are working on this one.
  }, [origin]);

  /**
   * Puts a recovered draft back on screen.
   *
   * `loadPdfIntoEditor` is deliberately NOT called. It mints fresh page ids and
   * returns its own state, so restoring through it would either render a document of
   * white pages (every background key missing) or, if its state were applied, hand
   * back the file as it sits on disk with every edit silently gone. The draft's
   * scene stays authoritative and only the page images are rebuilt, keyed on each
   * page's pinned source index — what survives insert, delete, duplicate, reorder.
   *
   * No `beginLoad`/`endLoad` bracket here either: `restoreOfferedDraft` already
   * brackets this callback and adopts the revision it returns, and a second bracket
   * would leave the history bridge unbalanced for the rest of the session.
   */
  const applyRestoredDraft = async (draft: LoadedDraft) => {
    const plan = planDraftRestore(draft);
    const restoredName = draft.descriptor.documentName;
    actions.deserialize(draft.scene);
    // In the same tick as the content, before anything can await.
    loadedKeyRef.current = draft.descriptor.documentKey;
    sourceBytesRef.current = plan.sourceBytes;

    /*
     * `unrendered` counts pages that WANTED an image and did not get one. A restore
     * is never failed for this — a document with one white page is far better than a
     * refused recovery — but it is always reported, because a user who is told
     * "recovered" over blank pages may save that document over the good one.
     */
    let unrendered = plan.pages.filter((page) => page.sourcePageIndex !== null).length;
    if (plan.redraw && plan.sourceBytes !== null) {
      try {
        const rebuilt = await restoreBackgrounds({
          pages: plan.pages,
          sourceBytes: plan.sourceBytes,
          documentName: restoredName,
        });
        setBackgrounds(rebuilt.backgrounds);
        unrendered = rebuilt.unrenderedPageIds.length;
      } catch (error) {
        // Only a failure to OPEN the source PDF reaches here; per-page failures are
        // absorbed inside. The scene is still restorable without any images.
        console.error("restore: could not open the draft's source PDF", error);
        setBackgrounds(assembleRestoredBackgrounds(plan.pages, new Map()));
      }
    } else {
      setBackgrounds(assembleRestoredBackgrounds(plan.pages, new Map()));
    }

    setFileName(restoredName);
    setFitMode("fit-page");
    setSidebarTab("pages");
    onLocalDocumentChange?.({ fileName: restoredName, hasDocument: true });
    setPersistenceNotice(
      describeRestoreResult({
        documentName: restoredName,
        complete: plan.caveat === null,
        unrenderedPageCount: unrendered,
      }),
    );
    /*
     * The LIVE revision, read after the awaits. `revision` from this render's
     * closure is the value from before the deserialize, and baselining the document
     * there would leave the coordinator believing the restore itself is an unsaved
     * change — forever, since nothing ever reaches that revision again.
     */
    return { historyRevision: service.revision };
  };

  const onRecoveryAction = async (action: RecoveryActionId) => {
    if (recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      if (action === "restore_draft") {
        const outcome = await persistence.restore(applyRestoredDraft);
        if (outcome.kind === "failed") {
          // The draft is NOT deleted on a failed restore; it stays on disk and the
          // offer can be taken again.
          setNotice("Your saved changes could not be restored. They are still stored on this device.");
        }
        return;
      }
      if (action === "delete_draft") {
        await persistence.deleteOffer();
        return;
      }
      // "Open the saved version": keep what is on screen and stop offering. The
      // draft is left on disk deliberately — declining once is not a decision to
      // destroy the only copy of the work.
      persistence.dismissOffer();
    } finally {
      setRecoveryBusy(false);
    }
  };

  /**
   * Uploads this tab's version as a NEW workspace document.
   *
   * The safest of the workspace-side outcomes: nothing that already exists is
   * written to, so it cannot lose either version. The upload route deduplicates by
   * content, though, so the response is inspected rather than assumed — telling a
   * user a copy was made when the server resolved onto the very document they are in
   * conflict with would be a false claim with their work on the line.
   */
  const duplicateAsNewDocument = async () => {
    if (!source) throw new Error("A duplicate needs a workspace document.");
    const name = duplicateCopyName(fileName);
    const bytes = await exportEditorPdf(state, sourceBytesRef.current ?? undefined);
    const form = new FormData();
    // A fresh copy: the export may be a view over a larger buffer, and Blob would
    // otherwise serialise the whole backing store.
    form.append("file", new File([new Uint8Array(bytes)], `${name}.pdf`, { type: "application/pdf" }));
    form.append("name", name);
    if (source.organizationId) form.append("organizationId", source.organizationId);
    // No Content-Type header: the browser must set the multipart boundary. The
    // route's CSRF check is origin-based, so same-origin credentials are enough.
    const response = await fetch(`/api/workspaces/${source.workspaceId}/documents/upload`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Duplicate upload failed with ${response.status}`);
    const payload = (await response.json()) as {
      document?: { id?: string };
      deduplicated?: boolean;
    };
    return describeDuplicateOutcome({
      workspaceId: source.workspaceId,
      newDocumentId: payload.document?.id ?? "",
      conflictedDocumentId: source.documentId,
      deduplicated: payload.deduplicated === true,
      name,
    });
  };

  const conflictView = persistence.view?.conflict ?? null;
  /** Identifies the conflict itself, so a fresh one reopens a closed dialog. */
  const conflictKey = conflictView
    ? `${conflictView.local.revision}:${conflictView.remote.serverVersion ?? "none"}`
    : null;

  /**
   * The conflict actions this SURFACE owns.
   *
   * The coordinator owns exactly one of them — replacing the workspace version — and
   * returns `not_owned` for the rest rather than silently swallowing them, so a
   * surface that forgets one is left with a button that visibly does nothing instead
   * of a dialog that lies. These are the rest.
   */
  const onConflictAction = async (
    action: ConflictActionId,
    options?: { confirmed?: boolean },
  ) => {
    if (conflictBusy) return;
    setConflictError(null);
    if (action === "cancel") {
      setConflictClosedKey(conflictKey);
      return;
    }
    setConflictBusy(true);
    try {
      if (action === "save_local_copy") {
        /*
         * A file on the user's own disk — the one outcome no server, no lock and no
         * other tab can take back. Offered even when the workspace is unknown, which
         * is exactly when it matters most.
         */
        const bytes = await exportEditorPdf(state, sourceBytesRef.current ?? undefined);
        const copyName = outputFileName({
          fallbackBase: fileName,
          suffix: "local-copy",
          ext: "pdf",
        });
        downloadBytes(bytes, copyName);
        setPersistenceNotice(`Your version was downloaded as "${copyName}".`);
        return;
      }
      if (action === "review_workspace") {
        if (!source) return;
        /*
         * A NEW TAB, never this one. Navigating away from here would close the local
         * version — the one thing the user has not decided about yet — in order to
         * look at the other one.
         */
        window.open(
          `/workspaces/${source.workspaceId}/documents/${source.documentId}`,
          "_blank",
          "noopener,noreferrer",
        );
        return;
      }
      if (action === "duplicate_as_new") {
        const outcome = await duplicateAsNewDocument();
        setPersistenceNotice(outcome.notice);
        // Only a real second document resolves the conflict. A deduplicated upload
        // made no copy, so the dialog stays and the choice is still open.
        if (outcome.resolved) setConflictClosedKey(conflictKey);
        return;
      }
      if (action === "replace_workspace") {
        const resolution = await persistence.resolveConflict(action, {
          confirmed: options?.confirmed === true,
        });
        if (resolution.kind === "replaced") {
          setServerVersion(resolution.serverVersion);
          setPersistenceNotice("Your version is now the one in the workspace.");
          setConflictClosedKey(conflictKey);
          return;
        }
        if (resolution.kind === "still_conflicted") {
          // Someone saved again between the check and the write. The dialog stays up
          // with the new facts rather than reporting a success that did not happen.
          setConflictError(
            "The workspace changed again while this was saving, so nothing was overwritten. Please choose again.",
          );
          return;
        }
        setConflictError(
          "That could not be saved to the workspace. Nothing was overwritten and your work is still here.",
        );
        return;
      }
      // Every remaining id belongs to the coordinator's own list and is handled
      // above; reaching here means a new action was added without a home.
      setConflictError("That option is not available for this document.");
    } catch (error) {
      console.error("Conflict action failed", error);
      setConflictError("That did not work. Nothing was overwritten and your work is still here.");
    } finally {
      setConflictBusy(false);
    }
  };

  const recoveryOffer = persistence.view?.recoveryOffer ?? null;
  const conflictOpen = conflictView !== null && conflictKey !== conflictClosedKey;
  /** The one limitation that means the work is not being protected at all. */
  const blockedBy = blockingLimitation(persistence.limitations);

  // What the current load state should look like on screen.
  const loadPresentation = presentLoad({ phase, timedOut, error: loadError });
  /** The terminal error's user-facing copy and actions. */
  const errorPresentation =
    phase === "error"
      ? presentLoadError(
          { ...(loadError ?? loadErrorFacts(null)), timedOut },
          { context: source ? "workspace" : "standalone" },
        )
      : null;

  /**
   * The single document-load announcement.
   *
   * One live region, not several: the status bar is deliberately not a live
   * region, the loading overlay is aria-hidden, and the error panel is a
   * role=alert that speaks its own heading. Substages return null from
   * `loadAnnouncement`, which is what stops a poll loop narrating every attempt.
   */
  const announcement = loadAnnouncement(phase, loadError);

  /**
   * Bounded placeholder thumbnails for the Pages rail.
   *
   * Only while a WORKSPACE document is loading its content: at that point the
   * editor state still holds the default blank page, so the real panel would
   * claim a one-page document. Once page metadata exists (or in the standalone
   * editor, where the blank page is genuinely the document) this is zero and the
   * real panel renders.
   */
  const pagesSkeletonCount =
    source && (phase === "loading-content" || phase === "processing-upload")
      ? placeholderThumbnailCount(null)
      : placeholderThumbnailCount(pages.length);

  const onErrorAction = useCallback(
    (action: LoadErrorAction["kind"]) => {
      switch (action) {
        case "retry":
          retryLoad();
          return;
        case "open-another":
          openPdfInputRef.current?.click();
          return;
        case "sign-in":
          // A full navigation, not a router push: the session is gone, so the
          // server must re-evaluate auth for the destination.
          window.location.assign(
            `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
          return;
      }
    },
    [retryLoad],
  );

  /*
   * THE ONE FACT, and the defect it closes.
   *
   * This was `canUndo`. Undo depth answers "has this document ever been edited",
   * which is not the question a tab dot asks — and it never goes back down, so a
   * document autosaved seconds ago still showed an unsaved-changes dot while the
   * status bar beside it said "Saved on this device". Both were rendered at once
   * in the recording that opened this phase.
   *
   * `statusHasPendingWork` reads the SAME projection the readout renders, so the
   * two cannot disagree — not because they are kept in step, but because there is
   * only one fact to render.
   */
  const status = persistence.view?.status ?? null;
  const dirty = status !== null && statusHasPendingWork(status);
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);

  // The canonical status itself, for a shell that renders it (the standalone app
  // bar). The coordinator publishes only when its state actually changes, so this
  // fires per state transition rather than per render.
  const onStatusRef = useRef(onSaveStatusChange);
  onStatusRef.current = onSaveStatusChange;
  useEffect(() => {
    onStatusRef.current?.(status);
  }, [status]);

  useShortcuts(handlers, {
    onToolChange: setTool,
    onZoomIn: zoomIn,
    onZoomOut: zoomOut,
    // M6: Ctrl+0 = fit page; Ctrl+1/Ctrl+2 = 100%/200%.
    onZoomReset: () => setFitMode("fit-page"),
    onZoom100: () => applyManualZoom(1),
    onZoom200: () => applyManualZoom(2),
    onPagePrev: () => goToPage(activeIndex - 1),
    onPageNext: () => goToPage(activeIndex + 1),
    onPageFirst: () => goToPage(0),
    onPageLast: () => goToPage(pages.length - 1),
    onSave,
    onExport,
    // Ctrl+F. Always opens (never toggles closed): pressing Ctrl+F with the bar
    // already open means "search again", and closing it under the user's hand
    // would be the opposite of the intent. Escape and the X button close it.
    onFind: () => setFindOpen(true),
  });

  // Announce WHAT KIND of thing is selected, not just a count — and say the same
  // thing the canvas chrome and the inspector say. This announcement used to
  // describe a read-only imported run as an editable duplicate of the original
  // PDF text, which was the audible version of the very contradiction this pass
  // removed: telling a screen-reader user the run can be edited would leave them
  // hunting for controls that are deliberately absent.
  const primaryId = state.selection.primaryId;
  const primaryObj = primaryId ? activePage.objects[primaryId] : undefined;
  const primaryIsReadonlySourceText =
    primaryObj != null && !resolveSelectionAffordance([primaryObj]).allowsGeometry;

  /*
   * The floating contextual object toolbar (P1 Phase G).
   *
   * Resolved HERE, not in the canvas, because every action it offers must route
   * through infrastructure this component already owns: `handlers` (the
   * history-backed commands), the tool state (highlight/comment/crop are tools),
   * and the Inspector (the colour/stroke/opacity actions focus a real control
   * rather than reimplementing a picker in a floating bar).
   */
  const selectedObjectsForToolbar = state.selection.ids
    .map((id) => activePage.objects[id])
    .filter((obj): obj is NonNullable<typeof obj> => Boolean(obj));
  const toolbarCrop = resolveCropEligibility(selectedObjectsForToolbar);
  const objectToolbarActions = resolveObjectToolbar({
    objects: selectedObjectsForToolbar,
    cropAvailable: toolbarCrop.available,
    ...(toolbarCrop.available ? {} : { cropReason: toolbarCrop.reason }),
  });

  const onObjectToolbarAction = (id: ObjectToolbarActionId) => {
    switch (id) {
      case "duplicate":
        handlers.duplicate();
        break;
      case "delete":
        handlers.delete();
        break;
      // Read-only source text: copying the ORIGINAL characters is the one
      // content operation it legitimately supports.
      case "copyText":
        handlers.copy();
        break;
      case "crop":
        setTool("crop");
        break;
      case "highlight":
        setTool("highlight");
        break;
      case "comment":
        setTool("annotation");
        break;
      /*
       * The property actions open the Inspector on Properties rather than
       * duplicating its controls in the floating bar. A second colour picker
       * would be a second source of truth for the same property — and the panel
       * already commits through the facade with the right undo labels.
       *
       * `selectTab` also REVEALS the panel (a tab click that changed a hidden
       * panel would be a dead control), so no separate open call is needed.
       */
      case "replace":
      case "fill":
      case "stroke":
      case "color":
      case "width":
      case "opacity":
        changeFocusCanvas(false);
        panels.selectTab("properties");
        break;
      // `more` promotes the full right-click menu at the selection, so the long
      // surface stays available without the bar growing to hold it.
      case "more": {
        /*
         * Anchored at the selection's on-screen position, converted the same way
         * the canvas converts it (page space → screen, offset by the host's
         * viewport rect) so the menu opens ON the object rather than at a corner.
         * `ContextMenu` clamps itself to the viewport from there.
         */
        const host = canvasHostRef.current?.getBoundingClientRect();
        const bounds = selection.bounds;
        if (host && bounds) {
          setContextMenu({
            x: host.left + viewport.pan.x + bounds.x * viewport.zoom,
            y: host.top + viewport.pan.y + (bounds.y + bounds.height) * viewport.zoom,
          });
        }
        break;
      }
      case "edit":
        // Handled inside the canvas, which owns the inline text editor.
        break;
    }
  };

  // Roving-tabindex arrow navigation for the sidebar tablist.
  const onTabListKeyDown = (e: React.KeyboardEvent) => {
    const index = SIDEBAR_TABS.findIndex((t) => t.id === sidebarTab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % SIDEBAR_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SIDEBAR_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const tab = SIDEBAR_TABS[next].id;
    setSidebarTab(tab);
    tabRefs.current.get(tab)?.focus();
  };

  // ONE right-hand dock (see editorPanelLayout). Properties and the document
  // panels share a single 320px column and a single flat tab strip; below the
  // breakpoint the same Inspector opens as a drawer over the canvas. Two docked
  // columns cost 640px of permanent furniture and made the page the smallest
  // region on screen at the widest windows.
  const rightInspector =
    panels.layout.inspector === "docked" ? (
      <aside className="flex w-[320px] shrink-0 border-l border-editor-border bg-editor-surface">
        <EditorInspector
          tabs={panels.tabs}
          activeTab={panels.activeTab}
          onSelectTab={panels.selectTab}
          documentPanel={documentInspectorNode}
          onCollapse={panels.toggleInspector}
        />
      </aside>
    ) : null;

  return (
    <PremiumEditorFrame
      containerRef={frameRef}
      appHeader={appHeader}
      tabsSlot={header}
      toolbar={
        <>
          <EditorToolbar
            focused={focusCanvas}
            onToggleFocus={() => changeFocusCanvas(!focusCanvas)}
            tool={tool}
            onToolChange={setTool}
            toolPinned={toolSession.pinned}
            onToolPinnedChange={setToolPinned}
            onExport={onExport}
            // A Workspace document is opened by the Workspace, not by a file
            // picker: offering "Open PDF" there would silently replace the document
            // the tab claims to be showing with an unrelated local file.
            onOpenPdf={source ? undefined : onOpenPdf}
            // "Organize Pages" surfaces the page rail rather than opening a second
            // page-management UI: the rail already owns every implemented page
            // operation (insert/duplicate/rotate/delete/reorder), so a separate
            // organiser would be a parallel list of the same commands.
            onOrganizePages={() => {
              changeFocusCanvas(false);
              setSidebarTab("pages");
              toggleLeftRail(true);
            }}
            organizePagesActive={leftRailOpen && sidebarTab === "pages"}
          />
          {shapeTemplate && <ShapeControls template={shapeTemplate} onChange={next => setShapeDefaults(current => ({ ...current, [tool]: next }))} />}
          {tool === "eraser" && <div className="flex flex-wrap items-center gap-3 border-b border-editor-border bg-editor-surface px-3 py-2 text-sm text-editor-text">
            <strong>Partial ink eraser</strong>
            <label className="flex min-h-11 items-center gap-2">Eraser diameter
              <input aria-label="Eraser diameter" type="range" min={8} max={128} step={2}
                value={eraserRadius * 2} onChange={e => setEraserRadius(Number(e.target.value) / 2)}
                className="min-h-11 w-32 accent-editor-accent" />
              <output className="min-w-16 tabular-nums">{eraserRadius * 2} pt</output>
            </label>
            <span className="text-editor-muted">Ink only · stays active · Esc cancels</span>
          </div>}
          {/* Draw's contextual controls: present only while a freehand tool is
              active, which is also the unmistakable "Draw mode" signal. */}
          {isDrawingTool(tool) ? (
            <DrawControls
              settings={drawSettings}
              onChange={setDrawSettings}
              compact={compact}
            />
          ) : null}
        </>
      }
      notices={
        blockedBy !== null || notice !== null || persistenceNotice !== null ? (
          <>
            {/*
              The ONE limitation worth a banner, and it has no Dismiss: it is not an
              event that happened, it is a standing fact about this browser context,
              and it stays true until the context changes. A tab that cannot take the
              cross-tab lock still saves the document; a tab with no store does not.
              The rest live in the save-status popover — see `secondaryLimitations`,
              and see why: four stacked alerts over an editor teach a user to dismiss
              alerts, and then the one that mattered goes with them.
            */}
            {blockedBy !== null ? (
              <div
                role="alert"
                className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{blockedBy.message}</span>
              </div>
            ) : null}
            {notice !== null ? (
              <div
                role="alert"
                className="flex shrink-0 items-start justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
              >
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="shrink-0 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {/*
              Good news, in its own band. The red one above is styled as a failure
              because everything else that uses it is one — and "Your unsaved work is
              back", shown in that band, reads as a problem to the person least able
              to afford ambiguity about it.
            */}
            {persistenceNotice !== null ? (
              <div
                role="status"
                className="flex shrink-0 items-start justify-between gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800"
              >
                <span>{persistenceNotice}</span>
                <button
                  type="button"
                  onClick={() => {
                    setPersistenceNotice(null);
                    // Also tells the coordinator, so the recovered state stops being
                    // reported by the status readout: two places showing the same
                    // recovery, only one of which can be dismissed, is the bug where
                    // "Recovered" sticks to the document for the rest of the session.
                    persistence.acknowledgeRecovery();
                  }}
                  className="shrink-0 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </>
        ) : undefined
      }
      leftNav={
        // 180px (P1 Phase D1, revised in the final visual pass). D1 chose 176px
        // to hand 8px back to the canvas, but the collapse button was later added
        // to the tab row and the three labels no longer fitted: "Layers" measured
        // client 43px vs scroll 47px and "History" 43 vs 50, so PRIMARY
        // NAVIGATION shipped with a silent ellipsis. Re-measuring the candidate
        // geometries found `180 / 28` clean, which is what this is — 4px of canvas
        // for three readable tab labels.
        focusCanvas ? undefined : leftRailOpen ? (
          <aside className="hidden w-[180px] shrink-0 flex-col border-r border-editor-border bg-editor-surface md:flex">
            <div className="flex shrink-0 items-center border-b border-editor-border pl-1 pr-0.5">
              <div
                role="tablist"
                aria-label="Sidebar panels"
                className="flex min-w-0 flex-1"
                onKeyDown={onTabListKeyDown}
              >
                {SIDEBAR_TABS.map((t) => (
                  <button
                    key={t.id}
                    ref={(el) => {
                      if (el) tabRefs.current.set(t.id, el);
                      else tabRefs.current.delete(t.id);
                    }}
                    role="tab"
                    id={`editor-tab-${t.id}`}
                    aria-selected={sidebarTab === t.id}
                    aria-controls={`editor-tabpanel-${t.id}`}
                    tabIndex={sidebarTab === t.id ? 0 : -1}
                    title={t.label}
                    /*
                     * Each tab is sized to its OWN label rather than `flex-1`.
                     * Equal thirds make the widest label ("History") set the
                     * budget for all three, and three times that budget does not
                     * fit beside the collapse button at any rail width in the
                     * 160-180px band — which is exactly how the shipped rail
                     * clipped two of its three tabs. Sizing to content spends
                     * 141px total where equal thirds needed 150px, so the labels
                     * fit with room to spare and "Pages" stops paying for
                     * "History". `truncate` stays as a backstop for longer
                     * locales; at 12px in en-GB nothing truncates (measured by
                     * `editor-responsive-probe.mjs`, which fails on any clipped
                     * tab).
                     */
                    className={`min-w-0 truncate border-b-2 px-1 py-2.5 text-[12px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent ${
                      sidebarTab === t.id
                        ? "border-editor-accent text-editor-accent"
                        : "border-transparent text-editor-muted hover:bg-editor-subtle hover:text-editor-text"
                    }`}
                    onClick={() => setSidebarTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => toggleLeftRail(false)}
                aria-label="Collapse panel"
                title="Collapse panel"
                className="flex min-h-8 w-7 shrink-0 items-center justify-center rounded-control text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
              >
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div
              role="tabpanel"
              id={`editor-tabpanel-${sidebarTab}`}
              aria-labelledby={`editor-tab-${sidebarTab}`}
              className="flex-1 overflow-hidden"
            >
              {sidebarTab === "pages" ? (
                /*
                  While a Workspace document is still loading, the editor state
                  holds only its default blank page — so the real PagesPanel
                  would show "1" and imply a one-page document. A small BOUNDED
                  set of placeholders stands in until the true page count exists;
                  it is never one-per-page, because a 200-page skeleton costs
                  more layout than the thumbnails it replaces and misstates how
                  much is loading. Page 1 is never blocked on rasterizing the
                  rest: the real panel takes over the moment state lands.
                */
                pagesSkeletonCount > 0 ? (
                  <PagesPanelSkeleton count={pagesSkeletonCount} />
                ) : (
                  <PagesPanel
                    backgroundForPage={(id) => backgrounds.get(id)}
                    onPageDuplicated={(sourceId, newId) =>
                      setBackgrounds((prev) => {
                        const src = prev.get(sourceId);
                        if (src === undefined) return prev;
                        const next = new Map(prev);
                        next.set(newId, src);
                        return next;
                      })
                    }
                  />
                )
              ) : sidebarTab === "layers" ? (
                <LayersPanel />
              ) : (
                <HistoryPanel />
              )}
            </div>
          </aside>
        ) : (
          /* Collapsed: a narrow edge rail that gives the canvas the width back
             while keeping the panel one click away. Hidden below `md` for the
             same reason the expanded rail is — narrow layouts use drawers. */
          <div className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-editor-border bg-editor-surface py-2 md:flex">
            <button
              type="button"
              onClick={() => toggleLeftRail(true)}
              aria-label="Expand panel"
              title="Expand panel"
              className="flex min-h-9 min-w-9 items-center justify-center rounded-control text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
            >
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            </button>
            {SIDEBAR_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSidebarTab(t.id);
                  toggleLeftRail(true);
                }}
                aria-label={`Show ${t.label}`}
                title={t.label}
                className={`flex min-h-9 min-w-9 items-center justify-center rounded-control transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent ${
                  sidebarTab === t.id
                    ? "bg-editor-accentsoft text-editor-accent"
                    : "text-editor-muted hover:bg-editor-subtle hover:text-editor-text"
                }`}
              >
                {t.id === "pages" ? (
                  <Files className="h-4 w-4" aria-hidden="true" />
                ) : t.id === "layers" ? (
                  <LayersIcon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <HistoryIcon className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        )
      }
      canvas={
        <div className="relative flex-1 overflow-hidden">
          <Rulers viewport={viewport} origin={viewport.pan} pageSize={displaySize} />
          {/* In-document find (Ctrl+F). Mounted over the canvas so it floats with
              the page rather than pushing the layout, and so Escape returns focus
              to the surface the user was reading. */}
          <DocumentFindBar
            open={findOpen}
            onClose={() => setFindOpen(false)}
            onGoToPage={(pageNumber) => goToPage(pageNumber - 1)}
          />
          <div ref={canvasHostRef} className="absolute inset-0 left-[18px] top-[18px]">
            <EditorCanvas
              viewport={viewport}
              onViewportChange={onCanvasViewportChange}
              tool={tool}
              onToolChange={setTool}
              onInsertionComplete={completeInsertion}
              drawSettings={drawSettings}
              eraserRadius={eraserRadius}
              shapeTemplate={shapeTemplate}
              backgroundImageForPage={(id) => backgrounds.get(id)}
              onContextMenu={(_pagePoint: Point, client: Point) => setContextMenu({ x: client.x, y: client.y })}
              objectToolbar={
                objectToolbarActions
                  ? { actions: objectToolbarActions, onAction: onObjectToolbarAction }
                  : undefined
              }
              onPagePointerMove={pointerSubjectRef.current.publish}
              onInteractionStatusChange={interactionSubjectRef.current.publish}
              /*
               * The one editor mutation that is invisible to `revision`: characters
               * typed into the inline text editor live in a textarea until they are
               * committed. Persistence is told about them directly so the editor
               * cannot report "No changes yet" — or "Saved" — over the user's typing.
               */
              onUncommittedInputChange={persistence.noteUncommittedInput}
            />
          </div>
          {/*
            The standalone editor's LOCAL file open. No network, no preparation
            state and nothing to poll — but the same page-shaped presentation, so
            opening a file looks the same in both places.
          */}
          {loading ? (
            <DocumentLoadingOverlay
              presentation={{ message: `${openingFileName} — ${localLoad.phase === "rendering" ? `Rendering page ${(localLoad.completed ?? 0) + 1} of ${localLoad.total}` : localLoad.phase === "preparing" ? "Preparing PDF" : "Reading document"}`, spinner: true, retry: false }}
            />
          ) : null}
          {/* The Workspace document load. Every non-ready phase renders
              something that explains itself, and the two phases that can
              persist (processing, error) both offer a way out — which is what
              makes an endless spinner unreachable rather than merely
              unlikely. */}
          {loadPresentation.spinner ? (
            <DocumentLoadingOverlay
              presentation={loadPresentation}
              // The real ratio once the PDF has been parsed, the A4 default
              // before that. Passing the live page keeps the refinement from
              // being a jump: by the time this is non-default the sheet is
              // already on screen at the same position.
              pageSize={phase === "initializing-editor" ? displaySize : null}
              // Only the preparation-polling phase sets `retry`; ordinary
              // loading has nothing to retry and renders no button.
              onRetry={loadPresentation.retry ? retryLoad : undefined}
            />
          ) : null}
          {errorPresentation ? (
            <DocumentErrorPanel
              presentation={errorPresentation}
              onAction={onErrorAction}
              secondary={onBack}
            />
          ) : null}
          {exporting ? (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-editor-bg/85"
              aria-busy="true"
            >
              <div className="rounded-panel border border-editor-border bg-editor-surface px-4 py-3 text-editor-text shadow-apppanel">
                <AsyncStatus phase="pending" message="Exporting PDF" fileName={fileName} />
              </div>
            </div>
          ) : null}
          {canvasOverlay}
        </div>
      }
      rightInspector={focusCanvas ? undefined : rightInspector}
      statusBar={
        <StatusBar
          zoom={viewport.zoom}
          tool={tool}
          toolPinned={toolSession.pinned}
          pointer={pointerSubjectRef.current}
          interaction={interactionSubjectRef.current}
          compact={compact}
          trailing={
            /*
             * In the status bar rather than the toolbar, and at the far end of it.
             * "Where is my work" is a persistent fact about the document, like the
             * zoom and the page count beside it — not an action, which is what the
             * toolbar is for. It renders only once persistence has a view (never
             * during the server render, and never on a disabled surface), because a
             * readout that says nothing is worse than no readout: it looks like a
             * claim.
             */
            persistence.view !== null ? (
              <SaveStatusIndicator
                status={persistence.view.status}
                breakdown={persistence.view.breakdown}
                limitations={secondaryLimitations(persistence.limitations)}
                identityNotice={guestIdentityNotice({
                  origin,
                  persisted: guestIdentityPersisted,
                })}
                onRetry={(channel) =>
                  channel === "local" ? persistence.retryLocal() : persistence.retryRemote()
                }
                onResolve={
                  // Present only while a conflict is standing — which is why closing
                  // the dialog is safe: this is the way back to it.
                  conflictView !== null ? () => setConflictClosedKey(null) : undefined
                }
                onSaveNow={() => {
                  void persistence.saveNow();
                }}
                compact={compact}
              />
            ) : null
          }
        />
      }
      floatingControls={
        // Always mounted, not compact-only: this capsule is now the primary home
        // of zoom + page navigation at every width (the toolbar gave up its zoom
        // cluster so the labelled row could fit a 1366px laptop). The status bar
        // keeps its readouts on wide containers, where the two do not collide.
        <FloatingCanvasControls
          pageNumber={activeIndex + 1}
          pageCount={pages.length}
          onPrevPage={() => goToPage(activeIndex - 1)}
          onNextPage={() => goToPage(activeIndex + 1)}
          onGoToPage={(n) => goToPage(n - 1)}
          // The zoom FACTOR, not a pre-rounded percentage: the capsule's own
          // disabled-state logic compares against the real clamp bounds, and a
          // rounded percentage cannot tell 800% (maxed) from 799.6% (not).
          zoom={viewport.zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFitPage={() => setFitMode("fit-page")}
          onZoomPreset={applyManualZoom}
          onFitMode={setFitMode}
          fitMode={fitMode}
          panActive={tool === "hand"}
          onPanMode={() => setTool("hand")}
          onSelectMode={() => setTool("select")}
          // The canonical tool, so the capsule's Hand/Select pair can report the
          // truth. Without it the bar derived Select as "not Hand" and claimed
          // aria-pressed while Rectangle or Draw was the real instrument.
          activeTool={tool}
          // A real page overview: the Pages rail owns every implemented page
          // operation (insert/duplicate/rotate/delete/reorder), so this reveals
          // that surface rather than being a decorative grid icon. Same intent as
          // the toolbar's "Organize Pages" — one command, two entry points, not
          // two implementations.
          onPageOverview={() => {
            changeFocusCanvas(false);
            setSidebarTab("pages");
            toggleLeftRail(true);
          }}
          pageOverviewActive={leftRailOpen && sidebarTab === "pages"}
          // One Inspector, one toggle. Offered at every width now: where the
          // panel docks this collapses/restores the dock, and where it cannot it
          // opens the drawer — the same control, honest behaviour per width.
          onToggleInspector={() => { changeFocusCanvas(false); panels.toggleInspector(); }}
          inspectorActive={!focusCanvas && panels.layout.inspector !== "closed"}
          // The CANVAS width, not the frame's: the capsule lives inside the
          // canvas region, so what it can fit is decided by the space left after
          // the rail and the Inspector dock — the two things that move.
          containerWidth={hostSize?.width ?? null}
        />
      }
      overlays={
        <>
          {!focusCanvas && panels.layout.inspector === "drawer" ? (
            <EditorPanelDrawer title="Inspector" onClose={panels.closeDrawer}>
              <EditorInspector
                tabs={panels.tabs}
                activeTab={panels.activeTab}
                onSelectTab={panels.selectTab}
                documentPanel={documentInspectorNode}
              />
            </EditorPanelDrawer>
          ) : null}
          {contextMenu ? (
            <ContextMenu
              position={contextMenu}
              handlers={handlers}
              onClose={() => setContextMenu(null)}
              onCropImage={() => setTool("crop")}
            />
          ) : null}
          {/* Screen-reader announcements for selection + history changes (Part 11). */}
          <div className="sr-only" role="status" aria-live="polite">
            {state.selection.ids.length === 0
              ? "No selection"
              : state.selection.ids.length === 1 && primaryIsReadonlySourceText
                ? "Original PDF text selected, read-only. It cannot be moved or restyled; you can copy the text."
                : `${state.selection.ids.length} object${state.selection.ids.length === 1 ? "" : "s"} selected`}
            {canUndo ? `; can undo ${undoLabel}` : ""}
            {canRedo ? `; can redo ${redoLabel}` : ""}
          </div>
          {/* Active-tool announcement (M6.8): tool switches are announced without
              spamming — the text only changes when the tool actually changes. */}
          <div className="sr-only" role="status" aria-live="polite">
            {TOOL_LABELS[tool]} tool active
          </div>
          {/*
            The document-load announcement (Phase J). ONE region for the whole
            load lifecycle: "Opening document." → "Document loaded." / "Could not
            open document. <heading>."
            Substages are silent by construction (`loadAnnouncement` returns null
            for them), so a preparation poll cannot narrate its own retries; and
            the status bar stays a plain readout rather than becoming a third
            competing live region.
          */}
          <div className="sr-only" role="status" aria-live="polite">
            {loading ? `Opening ${openingFileName}` : announcement}
          </div>
          {!source && (
            <input ref={openPdfInputRef} type="file" accept="application/pdf" className="hidden" onChange={onOpenPdfFile} aria-hidden="true" />
          )}
          {/*
            The recovery offer, above everything. It is raised by a page load rather
            than a click, and it is the only moment the user can still choose — so it
            comes before the document is touched, not after.
          */}
          {recoveryOffer !== null ? (
            <RecoveryPromptDialog
              prompt={recoveryOffer}
              busy={recoveryBusy}
              onAction={(action) => {
                void onRecoveryAction(action);
              }}
              // Reached only for a non-blocking notice; a required choice has no
              // dismiss path at all, and "Open the saved version" is its "no thanks".
              onDismiss={() => persistence.dismissOffer()}
            />
          ) : null}
          {conflictOpen && conflictView !== null ? (
            <ConflictDialog
              conflict={conflictView}
              // Without a workspace there is nothing to review or duplicate INTO, and
              // an action that cannot run must not be offered during a conflict.
              workspaceKnown={source !== null}
              busy={conflictBusy}
              error={conflictError}
              onAction={(action, options) => {
                void onConflictAction(action, options);
              }}
            />
          ) : null}
        </>
      }
    />
  );
}
