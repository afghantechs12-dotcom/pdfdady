"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Columns2, FileText, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { EditorWorkspace } from "@/components/editor/EditorWorkspace";
import { EditorErrorBoundary } from "@/components/editor/EditorErrorBoundary";
import { workspaceHref } from "@/components/app/appShellLogic";
import { CommandPalette } from "./CommandPalette";
import { DocumentInspector } from "./DocumentInspector";
import { PublishVersionButton, useWorkspacePublish } from "./PublishVersionButton";
import {
  activePaneOf,
  activeTabAfterClose,
  droppedTabIds,
  droppedTabsMessage,
  isSplit,
  openIntent,
  panesFromSession,
  reconcileSession,
  type WorkbenchPane,
  type WorkbenchSession,
  type WorkbenchTab,
} from "./workbenchLogic";

export interface DocumentWorkbenchProps {
  workspaceId: string;
  organizationId: string;
  /** The document the page was opened on. */
  documentId: string;
  documentName: string;
  /** The tab cap, from the session domain's own limits. */
  maxTabs: number;
  canWrite: boolean;
  /** The signed-in user, for comment authorship. */
  viewerId: string;
  /** True when the actor may moderate comment threads. */
  canModerate: boolean;
}

/** The server's session payload, as the routes return it. */
interface SessionPayload {
  id: string;
  activeTabId: string | null;
  version: number;
  tabs: Array<{
    id: string;
    documentId: string;
    versionId: string;
    title: string;
    state: { dirty: boolean; conflict: boolean; paneId: string | null };
  }>;
}

function toWorkbenchSession(payload: SessionPayload): WorkbenchSession {
  return {
    id: payload.id,
    activeTabId: payload.activeTabId,
    version: payload.version,
    tabs: payload.tabs.map((tab) => ({
      id: tab.id,
      documentId: tab.documentId,
      versionId: tab.versionId,
      title: tab.title,
      dirty: tab.state.dirty,
      conflict: tab.state.conflict,
      paneId: tab.state.paneId === "right" ? "right" : "left",
    })),
  };
}

/**
 * The Workspace document workbench.
 *
 * A genuinely integrated editor rather than a second copy of one: the tab strip
 * and the split arrangement are projections of the durable M7.12 session, and
 * every mutation goes through the session routes. Nothing here is simulated —
 * a second pane holds a *different* tab from the same server session, and if
 * there is no second tab there is no second pane.
 *
 * The session is created once, on mount, and reused. It is not created per
 * render and not created by the server component, so navigating between
 * documents does not leave a trail of empty sessions.
 *
 * No document bytes pass through session state: a tab carries a document id, a
 * version id and a title, and the editor fetches its own content from the
 * authorized content route.
 */
/**
 * Records that a person opened this document — the writer for the file manager's
 * `Opened` column, which showed `—` for every document because nothing called it.
 *
 * Fired from the editor's load-succeeded callback, so it means what the column
 * claims: a failed load records nothing, and neither does listing a Workspace,
 * rendering a card, or running a tool. Two panes report two opens, because two
 * documents were opened.
 *
 * Fire-and-forget by design. Nothing on screen depends on the response, and a
 * failed timestamp write must not become an error banner for a user whose document
 * opened perfectly well. `keepalive` so an open followed immediately by a
 * navigation still records.
 */
function recordDocumentOpened(workspaceId: string, organizationId: string, documentId: string) {
  void fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
      documentId,
    )}/opened`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
      keepalive: true,
    },
  ).catch(() => {});
}

export function DocumentWorkbench({
  workspaceId,
  organizationId,
  documentId,
  documentName,
  maxTabs,
  canWrite,
  viewerId,
  canModerate,
}: DocumentWorkbenchProps) {
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  // Guards the one-time bootstrap against React's development double-invoke,
  // which would otherwise issue two session creates and two opens.
  const bootstrappedRef = useRef(false);
  // True between mount and real unmount. Distinct from a per-run cancel flag:
  // StrictMode's practice cleanup must not be mistaken for the component going
  // away (see the bootstrap effect).
  const mountedRef = useRef(true);
  const sessionRef = useRef<WorkbenchSession | null>(null);
  sessionRef.current = session;

  /** Applies a server session, reporting anything the server dropped. */
  const applySession = useCallback((payload: SessionPayload) => {
    const incoming = toWorkbenchSession(payload);
    const previous = sessionRef.current;
    const dropped = droppedTabIds(previous, incoming);
    const reconciled = reconcileSession(previous, incoming);
    sessionRef.current = reconciled;
    setSession(reconciled);
    const message = droppedTabsMessage(dropped.length);
    if (message) setNotice(message);
    return reconciled;
  }, []);

  const request = useCallback(
    async (path: string, init: RequestInit): Promise<SessionPayload | null> => {
      const response = await fetch(path, { credentials: "same-origin", ...init });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(data?.error?.message ?? "That action could not be completed.");
        return null;
      }
      return (data?.session ?? null) as SessionPayload | null;
    },
    [],
  );

  // --- Bootstrap: get or create the session, then open this document ---------
  //
  // The one-time guard and the unmount signal are deliberately two different
  // things. StrictMode invokes this effect twice and runs the first cleanup in
  // between, so a single `cancelled` flag would be set while the component is
  // very much still mounted — abandoning the only bootstrap that will ever run
  // (the second invoke returns at the guard) and leaving the workbench with no
  // session and a spinner that never clears. `mountedRef` tracks real unmount;
  // the local flag only stops a *superseded* run from writing state.
  useEffect(() => {
    mountedRef.current = true;
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    void (async () => {
      const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/session`;
      try {
        // Read first. A GET never provisions, so an ordinary page view of a
        // Workspace the user only reads does not create a session row.
        const existing = await fetch(
          `${base}?organizationId=${encodeURIComponent(organizationId)}`,
          { credentials: "same-origin" },
        );
        let payload: SessionPayload | null = existing.ok
          ? ((await existing.json().catch(() => null))?.session ?? null)
          : null;

        if (!payload && canWrite) {
          payload = await request(base, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId }),
          });
        }
        if (!mountedRef.current) return;

        if (!payload) {
          // A viewer with no session still gets the document, just without a
          // durable tab set — which is honest about what their role allows.
          setBusy(false);
          return;
        }

        const current = applySession(payload);
        const intent = openIntent(current, documentId, maxTabs);
        if (intent.action === "refuse") {
          setNotice(intent.reason);
        } else if (intent.action === "focus") {
          const focused = await request(
            `${base}/tabs/${encodeURIComponent(intent.tabId)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ organizationId, sessionId: current.id, activate: true }),
            },
          );
          if (focused && mountedRef.current) applySession(focused);
        } else if (canWrite) {
          const opened = await fetch(`${base}/tabs`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              organizationId,
              sessionId: current.id,
              documentId,
              // The tab records the version it was opened against; the content
              // route reports the current one, and the editor's own load path
              // is what establishes it.
              versionId: "current",
              title: documentName,
            }),
          });
          const data = await opened.json().catch(() => null);
          if (opened.ok && data?.session && mountedRef.current) applySession(data.session);
          else if (!opened.ok && mountedRef.current) {
            setNotice(data?.error?.message ?? "This document could not be added to your tabs.");
          }
        }
      } finally {
        // Always cleared, on every path. This is the last thing that runs for
        // the one bootstrap the component performs, so anything that leaves it
        // set — a thrown request, an early return, a StrictMode re-invoke —
        // would strand the workbench on "Opening document…" with nothing left
        // to clear it.
        setBusy(false);
      }
    })();

    // No cleanup flag here on purpose: this effect's dependencies identify the
    // document being opened, so it does not re-run for a different one, and the
    // `bootstrappedRef` guard makes it run once. Unmount is tracked separately.
  }, [workspaceId, organizationId, documentId, documentName, maxTabs, canWrite, applySession, request]);

  // Real unmount, as opposed to StrictMode's practice cleanup. Kept in its own
  // effect with no dependencies so it is not torn down and rebuilt as the
  // bootstrap effect's inputs change.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const panes = useMemo(() => (session ? panesFromSession(session) : []), [session]);
  const split = session ? isSplit(session) : false;

  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/session`;

  const activateTab = useCallback(
    async (tabId: string) => {
      if (!session) return;
      const payload = await request(`${base}/tabs/${encodeURIComponent(tabId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, sessionId: session.id, activate: true }),
      });
      if (payload) applySession(payload);
    },
    [session, base, organizationId, request, applySession],
  );

  const closeTab = useCallback(
    async (tab: WorkbenchTab) => {
      if (!session) return;
      if (tab.dirty) {
        // An unsaved tab is not closed silently. This is a confirmation, not an
        // alert(): it states what is at stake and is dismissible.
        setStatus(`"${tab.title}" has unsaved changes. Export it before closing.`);
        return;
      }
      const next = activeTabAfterClose(session, tab.id);
      const payload = await request(`${base}/tabs/${encodeURIComponent(tab.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, sessionId: session.id }),
      });
      if (payload) {
        const applied = applySession(payload);
        if (next && applied.activeTabId !== next) void activateTab(next);
      }
    },
    [session, base, organizationId, request, applySession, activateTab],
  );

  const assignPane = useCallback(
    async (tabId: string, paneId: "left" | "right") => {
      if (!session) return;
      const response = await fetch(`${base}/split`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "assign", organizationId, sessionId: session.id, tabId, paneId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setNotice(data?.error?.message ?? "The panes could not be rearranged.");
        return;
      }
      // The split route returns pane state; the session is the authority on the
      // tab set, so it is re-read rather than patched from the split payload.
      const refreshed = await fetch(`${base}?organizationId=${encodeURIComponent(organizationId)}`, {
        credentials: "same-origin",
      });
      const data = await refreshed.json().catch(() => null);
      if (refreshed.ok && data?.session) applySession(data.session);
    },
    [session, base, organizationId, applySession],
  );

  const onDirtyChange = useCallback((tabId: string | null, dirty: boolean) => {
    if (!tabId) return;
    setSession((current) => {
      if (!current) return current;
      const target = current.tabs.find((tab) => tab.id === tabId);
      if (!target || target.dirty === dirty) return current;
      const next = {
        ...current,
        tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, dirty } : tab)),
      };
      sessionRef.current = next;
      return next;
    });
  }, []);

  const backHref = workspaceHref(workspaceId, organizationId, {});

  const activeTab = session
    ? (session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null)
    : null;
  const activePane = session ? activePaneOf(session) : "left";

  /**
   * Performs a command the server already authorized.
   *
   * The palette resolves *what and where*; the workbench is what acts. Only the
   * commands this surface can actually carry out are handled — anything else is
   * reported rather than silently ignored, so a command that appears to do
   * nothing is never mistaken for one that worked.
   */
  const onCommand = useCallback(
    (result: { commandId: string; documentId: string | null; paneId: string }) => {
      const target = session?.tabs.find((tab) => tab.documentId === result.documentId) ?? activeTab;
      switch (result.commandId) {
        case "document.close":
          if (target) void closeTab(target);
          break;
        case "view.split":
        case "view.split.right":
          if (target) void assignPane(target.id, "right");
          break;
        case "view.split.left":
        case "view.unsplit":
          if (target) void assignPane(target.id, "left");
          break;
        default:
          setStatus(`"${result.commandId}" is not available from the document workbench.`);
      }
    },
    [session, activeTab, closeTab, assignPane],
  );

  // The document the page was opened on, used when there is no session (a
  // viewer, or a Workspace where tab creation was refused) so the workbench
  // still shows the document rather than an empty frame.
  const fallbackSource = useMemo(
    () => ({ documentId, workspaceId, organizationId, name: documentName }),
    [documentId, workspaceId, organizationId, documentName],
  );

  /*
   * Publishing from the no-session fallback below.
   *
   * A separate wiring from the panes' because it is a separate editor mount, and
   * it exists because that fallback is not only the viewer's view: a writer whose
   * session could not be created still gets a working editor there, and an editor
   * that cannot publish is the dead end this phase is about. A viewer never sees
   * the control — `canWrite` gates it, and the version route re-checks membership
   * regardless of what any button renders.
   */
  const fallbackPublish = useWorkspacePublish({
    workspaceId,
    organizationId,
    documentId,
    documentName,
    onFailure: setNotice,
  });

  // The document inspector, embedded in the active editor shell through the
  // narrow page-navigation bridge. One inspector for the active document/tab —
  // in split view the inactive pane's editor renders no inspector rather than
  // duplicating one that would describe the wrong document. `documentId` is the
  // active tab's, so changing the active tab updates the inspector.
  const renderDocumentInspector = useCallback(
    (helpers: {
      currentPage: number | null;
      goToPage: (page: number) => void;
      tab: "outline" | "comments" | "versions";
    }) => (
      <DocumentInspector
        workspaceId={workspaceId}
        organizationId={organizationId}
        documentId={activeTab?.documentId ?? documentId}
        viewerId={viewerId}
        canWrite={canWrite}
        canModerate={canModerate}
        currentPage={helpers.currentPage}
        onNavigateToPage={helpers.goToPage}
        tab={helpers.tab}
      />
    ),
    [workspaceId, organizationId, activeTab?.documentId, documentId, viewerId, canWrite, canModerate],
  );

  if (busy && !session) {
    return (
      <div className="flex h-[calc(100vh-56px)] items-center justify-center bg-app-bg">
        <span className="flex items-center gap-2 text-sm text-app-muted">
          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          Opening document…
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          Opening document
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 flex-col bg-app-bg">
      {notice && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            Dismiss
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {status ?? ""}
      </p>

      {/* Workbench command bar. The palette is the keyboard path into the
          Workspace's own command registry; every entry it offers is
          re-authorized server-side before this surface acts on it. */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-app-border bg-app-surface px-3 py-1.5">
        <CommandPalette
          workspaceId={workspaceId}
          organizationId={organizationId}
          activeDocumentId={activeTab?.documentId ?? documentId}
          activePane={activePane}
          isSplit={split}
          onExecute={onCommand}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1",
            // Two panes side by side on wide screens; stacked below, where a
            // half-width PDF is unreadable.
            split ? "flex-col xl:flex-row" : "flex-col",
          )}
        >
        {session && panes.some((pane) => pane.tabs.length > 0) ? (
          panes
            .filter((pane) => pane.tabs.length > 0)
            .map((pane) => (
              <WorkbenchPaneView
                key={pane.id}
                pane={pane}
                split={split}
                workspaceId={workspaceId}
                organizationId={organizationId}
                backHref={backHref}
                canWrite={canWrite}
                onFailure={setNotice}
                canSplit={canWrite && session.tabs.length > 1}
                onActivate={activateTab}
                onClose={closeTab}
                onAssignPane={assignPane}
                onDirtyChange={onDirtyChange}
                // One inspector for the active document/tab: the pane hosting
                // the globally active tab renders it; the other pane does not.
                showInspector={pane.activeTabId === activeTab?.id}
                renderDocumentInspector={renderDocumentInspector}
              />
            ))
        ) : (
          // No durable session: the document still opens, just without tabs.
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-app-border bg-app-surface px-3 py-1.5">
              <Link
                href={backHref}
                className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-semibold text-app-muted transition-colors hover:bg-app-subtle hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Workspace
              </Link>
              <span className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-app-text">
                <FileText size={14} aria-hidden="true" className="text-primary" />
                {documentName}
              </span>
              {canWrite ? (
                <span className="ml-auto flex items-center">
                  <PublishVersionButton publish={fallbackPublish} />
                </span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              <EditorErrorBoundary>
                <EditorWorkspace
                  document={fallbackSource}
                  handleRef={fallbackPublish.surfaceRef}
                  onSaveStatusChange={fallbackPublish.onSaveStatus}
                  onDocumentLoaded={() =>
                    recordDocumentOpened(workspaceId, organizationId, documentId)
                  }
                  renderDocumentInspector={renderDocumentInspector}
                />
              </EditorErrorBoundary>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** One pane: its tab strip and the editor for its active tab. */
function WorkbenchPaneView({
  pane,
  split,
  workspaceId,
  organizationId,
  backHref,
  canWrite,
  onFailure,
  canSplit,
  onActivate,
  onClose,
  onAssignPane,
  onDirtyChange,
  showInspector,
  renderDocumentInspector,
}: {
  pane: WorkbenchPane;
  split: boolean;
  workspaceId: string;
  organizationId: string;
  backHref: string;
  /** Whether this actor may publish a version. The route re-checks regardless. */
  canWrite: boolean;
  /** Reports a publish failure to the workbench's alert banner. */
  onFailure: (message: string) => void;
  canSplit: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tab: WorkbenchTab) => void;
  onAssignPane: (tabId: string, paneId: "left" | "right") => void;
  onDirtyChange: (tabId: string | null, dirty: boolean) => void;
  /** True when this pane hosts the globally active tab (the inspector's document). */
  showInspector: boolean;
  renderDocumentInspector: (helpers: {
    currentPage: number | null;
    goToPage: (page: number) => void;
    tab: "outline" | "comments" | "versions";
  }) => React.ReactNode;
}) {
  const active = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null;

  const source = useMemo(
    () =>
      active
        ? { documentId: active.documentId, workspaceId, organizationId, name: active.title }
        : null,
    [active, workspaceId, organizationId],
  );

  const handleDirty = useCallback(
    (dirty: boolean) => onDirtyChange(active?.id ?? null, dirty),
    [onDirtyChange, active?.id],
  );

  /*
   * The publish wiring for THIS pane's editor. Per pane, not per workbench: a split
   * view holds two editors, and one handle shared between them would publish
   * whichever mounted last over whichever the user pressed.
   *
   * The hook is keyed on the active tab's document, so switching tabs neither
   * carries the previous document's "ready" onto the new button nor lets an
   * in-flight publish report against the wrong document.
   */
  const activeDocumentId = active?.documentId ?? null;
  const handleLoaded = useCallback(() => {
    if (activeDocumentId) recordDocumentOpened(workspaceId, organizationId, activeDocumentId);
  }, [workspaceId, organizationId, activeDocumentId]);

  const publish = useWorkspacePublish({
    workspaceId,
    organizationId,
    documentId: active?.documentId ?? "",
    documentName: active?.title ?? "",
    onFailure,
  });

  return (
    <section
      aria-label={split ? `${pane.id === "left" ? "Left" : "Right"} pane` : "Document"}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        split && pane.id === "right" && "border-t border-app-border xl:border-l xl:border-t-0",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-app-border bg-app-surface px-2 py-1">
        {pane.id === "left" && (
          <Link
            href={backHref}
            aria-label="Back to Workspace"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-app-muted transition-colors hover:bg-app-subtle hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </Link>
        )}

        <div role="tablist" aria-label="Open documents" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {pane.tabs.map((tab) => {
            const selected = tab.id === active?.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  // No vertical padding here on purpose: the tab button below is
                  // `h-7`, the same height as this row's other controls, so the
                  // chip hugs a 24px+ target instead of padding an 18px one.
                  "group flex min-w-0 shrink-0 items-center gap-1 rounded-control border px-2 transition-colors",
                  selected
                    ? "border-app-border bg-app-bg"
                    : "border-transparent hover:bg-app-subtle",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onActivate(tab.id)}
                  className="flex h-7 min-w-0 items-center gap-1.5 rounded text-[12px] font-semibold text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <FileText size={13} aria-hidden="true" className="shrink-0 text-primary" />
                  <span className="max-w-[10rem] truncate">{tab.title}</span>
                  {tab.dirty && (
                    <span
                      aria-label="Unsaved changes"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  )}
                  {tab.conflict && (
                    <span className="shrink-0 text-[10px] font-bold uppercase text-red-600">
                      conflict
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onClose(tab)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-app-muted opacity-0 transition-opacity hover:text-app-text focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {canWrite && active ? <PublishVersionButton publish={publish} /> : null}

        {canSplit && active && (
          <button
            type="button"
            onClick={() => onAssignPane(active.id, pane.id === "left" ? "right" : "left")}
            aria-label={
              pane.id === "left" ? "Move this document to the right pane" : "Move this document to the left pane"
            }
            title={pane.id === "left" ? "Move to right pane" : "Move to left pane"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-app-muted transition-colors hover:bg-app-subtle hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Columns2 size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {source ? (
          // Keyed on the tab so switching tabs mounts a fresh editor rather than
          // loading a new document into the previous one's undo history. The
          // inspector is attached to the editor of the active document only.
          //
          // The boundary is INSIDE the pane, so an editor render crash costs this
          // pane and nothing else: the tab strip, the other pane, the app shell
          // and the workspace navigation all keep working.
          <EditorErrorBoundary key={active?.id}>
            <EditorWorkspace
              document={source}
              onDirtyChange={handleDirty}
              // The wire defect F was: without these two the surface's
              // `exportBytes`/`noteVersionCommitted` are unreachable from the
              // Workspace chrome, so the document could be edited and autosaved
              // as a draft but never published as a version.
              handleRef={publish.surfaceRef}
              onSaveStatusChange={publish.onSaveStatus}
              onDocumentLoaded={handleLoaded}
              renderDocumentInspector={showInspector ? renderDocumentInspector : undefined}
            />
          </EditorErrorBoundary>
        ) : (
          <div className="grid h-full place-items-center text-sm text-app-muted">
            This pane holds no document.
          </div>
        )}
      </div>
    </section>
  );
}
