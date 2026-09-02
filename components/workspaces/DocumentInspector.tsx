"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { CommentsPanel, type CommentThreadView } from "./CommentsPanel";
import { currentOutlineIndex } from "./metadataLogic";
import {
  RESTORE_HELPER_TEXT,
  expectedRevisionFrom,
  isCurrentVersion,
  restoreAnnouncement,
  restoreEligibility,
  restoreFailure,
  type RestoreDocumentState,
  type RestoreFailure,
} from "./versionRestoreLogic";
import type { CommentAnchor } from "@/src/domain/entities/Collaboration";

/**
 * The document-scoped tabs this component can render.
 *
 * Kept as a local alias of the editor's tab union rather than its own list: the
 * strip now lives in `EditorInspector`, and two independent tab enumerations
 * would drift the moment one gained a tab.
 */
export type InspectorTab = "outline" | "comments" | "versions";

/** One outline entry as the metadata route returns it. */
interface OutlineItemView {
  id: string;
  title: string;
  pageNumber: number;
  depth: number;
}

/** One version as the version route returns it — no storage keys, by design. */
interface VersionView {
  id: string;
  versionNumber: number;
  origin: string;
  label: string | null;
  pageCount: number | null;
  sourceByteSize: number;
  createdAt: string;
  manifestDegraded: boolean;
  /**
   * Resolved server-side via `withCreatedByIdentities`, so the panel never has to
   * render a raw cuid for "who saved this". Optional because an older cached
   * response, or one served before the decoration landed, simply omits it.
   */
  createdByName?: string;
  createdByInitials?: string;
}

export interface DocumentInspectorProps {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  viewerId: string;
  canWrite: boolean;
  canModerate: boolean;
  /** The page currently in view, so a new comment anchors to it. */
  currentPage?: number | null;
  /** Jumps the editor to a page. Outline entries are inert without it. */
  onNavigateToPage?: (page: number) => void;
  /**
   * Which tab body to render. Controlled by the editor's Inspector, which owns
   * the single flat tab strip (`Properties · Outline · Comments · Versions`).
   */
  tab: InspectorTab;
}

/**
 * The workbench inspector's BODIES: outline, comments and version history for
 * the open document.
 *
 * This component renders no tab strip. It used to own one, but the editor now
 * has a single right-hand Inspector whose flat strip includes Properties, and
 * two nested strips made "Comments" cost two clicks. The editor selects the tab;
 * this component owns the data for each.
 *
 * Each tab is bound to the M7 route that already owns that data — no parallel
 * models and no second service. Each also loads lazily, on first activation:
 * fetching all three on mount would issue three requests for panels a user may
 * never open.
 *
 * Every panel reports its own failure in place. A panel that cannot load shows
 * why and offers a retry rather than rendering as empty, because an empty
 * outline and an outline that failed to load are different facts.
 */
export function DocumentInspector({
  workspaceId,
  organizationId,
  documentId,
  viewerId,
  canWrite,
  canModerate,
  currentPage = null,
  onNavigateToPage,
  tab,
}: DocumentInspectorProps) {
  return (
    <>
      {tab === "outline" && (
        <OutlineTab
          workspaceId={workspaceId}
          organizationId={organizationId}
          documentId={documentId}
          currentPage={currentPage}
          onNavigateToPage={onNavigateToPage}
        />
      )}
      {tab === "comments" && (
        <CommentsTab
          workspaceId={workspaceId}
          organizationId={organizationId}
          documentId={documentId}
          viewerId={viewerId}
          canWrite={canWrite}
          canModerate={canModerate}
          currentPage={currentPage}
        />
      )}
      {tab === "versions" && (
        <VersionsTab
          workspaceId={workspaceId}
          organizationId={organizationId}
          documentId={documentId}
          canWrite={canWrite}
        />
      )}
    </>
  );
}

/** Shared loading/error/empty presentation, so the three tabs behave alike. */
function PanelState({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyMessage: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-editor-muted" role="status">
        <Loader2 size={14} aria-hidden="true" className="animate-spin" />
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-xs text-red-700">
        <span className="flex items-center gap-1.5 font-semibold">
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-control border border-editor-border px-2 py-1 font-semibold text-editor-text transition-colors hover:border-editor-accent hover:text-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/40"
        >
          Try again
        </button>
      </div>
    );
  }
  // An empty panel and a failed one are different facts, and read differently.
  if (empty) return <p className="p-4 text-xs text-editor-muted">{emptyMessage}</p>;
  return <>{children}</>;
}

function OutlineTab({
  workspaceId,
  organizationId,
  documentId,
  currentPage,
  onNavigateToPage,
}: {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  currentPage: number | null;
  onNavigateToPage?: (page: number) => void;
}) {
  const [items, setItems] = useState<OutlineItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
            documentId,
          )}/outline?organizationId=${encodeURIComponent(organizationId)}`,
          { credentials: "same-origin" },
        );
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(data?.error?.message ?? "The outline could not be loaded.");
          return;
        }
        setItems(Array.isArray(data?.outline) ? data.outline : []);
      } catch {
        if (!cancelled) setError("The outline could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, organizationId, documentId, attempt]);

  const activeIndex = currentOutlineIndex(items, currentPage);

  return (
    <PanelState
      loading={loading}
      error={error}
      empty={items.length === 0}
      emptyMessage="This document has no outline."
      onRetry={() => setAttempt((value) => value + 1)}
    >
      <ul className="py-1">
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={!onNavigateToPage}
                onClick={() => onNavigateToPage?.(item.pageNumber)}
                style={{ paddingLeft: `${12 + Math.min(item.depth, 5) * 12}px` }}
                // `aria-current` rather than colour alone: the highlight is a
                // statement about where the reader is, and a screen reader user
                // needs that statement too.
                aria-current={active ? "location" : undefined}
                className={`flex w-full items-center justify-between gap-2 py-1.5 pr-3 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent/40 disabled:cursor-default disabled:hover:bg-transparent ${
                  active
                    ? "bg-editor-accentsoft font-semibold text-editor-accent"
                    : "text-editor-text hover:bg-editor-subtle"
                }`}
              >
                <span className="min-w-0 truncate">{item.title}</span>
                <span className="shrink-0 text-[10px] text-editor-muted">{item.pageNumber}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </PanelState>
  );
}

function CommentsTab({
  workspaceId,
  organizationId,
  documentId,
  viewerId,
  canWrite,
  canModerate,
  currentPage,
}: {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  viewerId: string;
  canWrite: boolean;
  canModerate: boolean;
  currentPage: number | null;
}) {
  const [threads, setThreads] = useState<CommentThreadView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
    documentId,
  )}/comments`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${base}?organizationId=${encodeURIComponent(organizationId)}`, {
        credentials: "same-origin",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error?.message ?? "Comments could not be loaded.");
        return;
      }
      setThreads(Array.isArray(data?.threads) ? data.threads : []);
    } catch {
      setError("Comments could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [base, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation re-reads: the server is the authority on thread state. */
  const mutate = useCallback(
    async (path: string, init: RequestInit) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(data?.error?.message ?? "That action could not be completed.");
        return;
      }
      setError(null);
      await load();
    },
    [load],
  );

  return (
    <PanelState
      loading={loading && threads.length === 0}
      error={loading ? null : error && threads.length === 0 ? error : null}
      empty={false}
      emptyMessage=""
      onRetry={() => void load()}
    >
      <CommentsPanel
        threads={threads}
        viewerId={viewerId}
        viewerCanComment={canWrite}
        viewerCanModerate={canModerate}
        loading={loading}
        error={error}
        currentPage={currentPage}
        onCreateThread={({ anchor, body }: { anchor: CommentAnchor; body: string }) =>
          mutate(base, {
            method: "POST",
            body: JSON.stringify({ organizationId, anchor, body }),
          })
        }
        onReply={(thread, body, parentMessageId) =>
          mutate(`${base}/${encodeURIComponent(thread.id)}/messages`, {
            method: "POST",
            body: JSON.stringify({ organizationId, body, parentMessageId }),
          })
        }
        onEdit={(thread, message, body) =>
          mutate(
            `${base}/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(message.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ organizationId, body, revision: message.revision }),
            },
          )
        }
        onDelete={(thread, message) =>
          mutate(
            `${base}/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(message.id)}`,
            {
              method: "DELETE",
              body: JSON.stringify({ organizationId, revision: message.revision }),
            },
          )
        }
        onToggleStatus={(thread) =>
          mutate(
            `${base}/${encodeURIComponent(thread.id)}/${
              thread.status === "resolved" ? "reopen" : "resolve"
            }`,
            {
              method: "POST",
              body: JSON.stringify({ organizationId, revision: thread.revision }),
            },
          )
        }
      />
    </PanelState>
  );
}

/** Bytes as a short human figure. Only ever called with a real server value. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Version history, with a real Restore.
 *
 * Two reads, not one: the version list AND the document record. The record is
 * what supplies `expectedRevision` for the restore's compare-and-swap — see
 * `versionRestoreLogic.ts` for why the version list's own `revision` field is
 * exactly one behind and must not be used.
 *
 * The busy and error state is entirely local (H37). Nothing here remounts the
 * editor: a restore creates a new version, and the panel reflects that by
 * refetching itself.
 */
function VersionsTab({
  workspaceId,
  organizationId,
  documentId,
  canWrite,
}: {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  canWrite: boolean;
}) {
  const [versions, setVersions] = useState<VersionView[]>([]);
  const [document, setDocument] = useState<RestoreDocumentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The version number a restore is in flight for, or null. */
  const [restoring, setRestoring] = useState<number | null>(null);
  const [failure, setFailure] = useState<RestoreFailure | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
    documentId,
  )}`;
  const query = `organizationId=${encodeURIComponent(organizationId)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // Both in parallel: the list is useless without the revision, and the
        // revision is useless without the list.
        const [listResponse, documentResponse] = await Promise.all([
          fetch(`${base}/versions?${query}`, { credentials: "same-origin" }),
          fetch(`${base}?${query}`, { credentials: "same-origin" }),
        ]);
        const data = await listResponse.json().catch(() => null);
        if (cancelled) return;
        if (!listResponse.ok) {
          setError(data?.error?.message ?? "Version history could not be loaded.");
          return;
        }
        setVersions(Array.isArray(data?.versions) ? data.versions : []);

        // A failed document read is NOT a failed panel: history still reads. It
        // costs the ability to restore, which `restoreEligibility` then explains
        // on each row rather than leaving a control that fails when pressed.
        const documentData = await documentResponse.json().catch(() => null);
        if (cancelled) return;
        const record = documentResponse.ok ? documentData?.document : null;
        setDocument(
          record && typeof record === "object"
            ? { revision: record.revision, currentVersionId: record.currentVersionId ?? null }
            : null,
        );
      } catch {
        if (!cancelled) setError("Version history could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, query, attempt]);

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
    [],
  );

  const reload = useCallback(() => {
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);

  /**
   * Posts one restore. Deliberately has no retry path: on a 409 the server is
   * telling us the document moved, and re-posting with a freshly read revision
   * would apply the restore on top of a state the user never saw — exactly what
   * the compare-and-swap exists to prevent. Recovery is the user pressing
   * "Reload versions" and deciding again.
   */
  const restore = useCallback(
    async (version: VersionView) => {
      const expectedRevision = expectedRevisionFrom(document);
      if (expectedRevision === null) return;
      setRestoring(version.versionNumber);
      setFailure(null);
      try {
        const response = await fetch(
          `${base}/versions/${encodeURIComponent(String(version.versionNumber))}/restore`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, expectedRevision }),
          },
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          setFailure(restoreFailure(response.status, data?.error?.message ?? null));
          return;
        }
        const created = data?.version?.versionNumber;
        setAnnouncement(
          typeof created === "number"
            ? restoreAnnouncement(version.versionNumber, created)
            : `Restored version ${version.versionNumber}.`,
        );
        // A new version now exists and the document revision advanced, so both
        // reads are stale. Refetch rather than patch state locally.
        setAttempt((value) => value + 1);
      } catch {
        setFailure({ message: "The version could not be restored.", offerReload: false });
      } finally {
        setRestoring(null);
      }
    },
    [base, document, organizationId],
  );

  return (
    <PanelState
      loading={loading}
      error={error}
      empty={versions.length === 0}
      emptyMessage="This document has no saved versions yet."
      onRetry={() => setAttempt((value) => value + 1)}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {failure && (
        <div role="alert" className="m-2 rounded-control border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          <p className="font-semibold">{failure.message}</p>
          {failure.offerReload && (
            <button
              type="button"
              onClick={reload}
              className="mt-1.5 rounded-control border border-red-300 px-2 py-1 font-semibold transition-colors hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40"
            >
              Reload versions
            </button>
          )}
        </div>
      )}
      <ul className="divide-y divide-app-border">
        {versions.map((version) => {
          const current = isCurrentVersion(version, document);
          const eligibility = restoreEligibility({
            version,
            document,
            canWrite,
            busy: restoring !== null,
          });
          const busy = restoring === version.versionNumber;
          return (
            <li key={version.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-semibold text-editor-text">
                  v{version.versionNumber}
                  {version.label ? ` · ${version.label}` : ""}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] uppercase text-editor-muted">
                  {current && (
                    <span className="rounded-full bg-primary-soft px-1.5 py-0.5 font-semibold text-primary">
                      Current
                    </span>
                  )}
                  {version.origin}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-editor-muted">
                {/* The server resolves the author; a missing name is never faked. */}
                {version.createdByName ? `${version.createdByName} · ` : ""}
                {formatter.format(new Date(version.createdAt))}
              </p>
              <p className="text-[11px] text-editor-muted">
                {/* Page count is shown only where the server recorded one. */}
                {version.pageCount !== null ? `${version.pageCount} pages · ` : ""}
                {formatBytes(version.sourceByteSize)}
              </p>
              {version.manifestDegraded && (
                <p className="mt-0.5 text-[11px] font-semibold text-amber-700">
                  This version&apos;s details could not be read fully.
                </p>
              )}
              {/* Rendered on every row so the reason for a disabled control is
                  discoverable (H24), rather than the action simply vanishing. */}
              <button
                type="button"
                disabled={!eligibility.enabled}
                title={eligibility.reason ?? RESTORE_HELPER_TEXT}
                onClick={() => void restore(version)}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-control border border-editor-border px-2 py-1 text-[11px] font-semibold text-editor-text transition-colors hover:border-editor-accent hover:text-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/40 disabled:cursor-not-allowed disabled:border-editor-border disabled:text-editor-muted disabled:hover:border-editor-border disabled:hover:text-editor-muted"
              >
                {busy && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
                {busy ? "Restoring…" : "Restore"}
              </button>
            </li>
          );
        })}
      </ul>
    </PanelState>
  );
}
