"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import type { EditorPage } from "@/src/domain/editor/document";
import { rotatedPageSize } from "@/src/application/editor/coordinates/PageRotation";
import {
  EMPTY_PAGES_SELECTION,
  insertionIndexFromPointer,
  moveTargetIndex,
  normalizePagesSelection,
  reducePageClick,
  type MeasuredItem,
  type PagesSelection,
} from "./pagesPanelLogic";

/**
 * The Pages panel (M6): page thumbnails with live backgrounds, multi-select
 * (click / Ctrl+click / Shift+click — panel-local, independent of the object
 * selection), pointer-drag reorder with an insertion indicator, keyboard
 * reorder (Ctrl+Arrow), a per-page action bar, and a right-click context menu.
 * All page mutations go through the facade so they are undoable; multi-page
 * batches run in one history transaction (one undo entry).
 */
export interface PagesPanelProps {
  /** Per-page rasterized background (data URL), as used by the canvas. */
  backgroundForPage: (pageId: string) => string | undefined;
  /** Fired after a duplicate so the workspace can copy the source's background. */
  onPageDuplicated?: (sourcePageId: string, newPageId: string) => void;
}

/** Pointer travel (px) before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;

interface DragState {
  pageId: string;
  fromIndex: number;
  startX: number;
  startY: number;
  active: boolean;
  items: MeasuredItem[];
  dropSlot: number | null;
}

export function PagesPanel({ backgroundForPage, onPageDuplicated }: PagesPanelProps) {
  const { state, service, actions, activePage } = useEditorContext();
  const pages = state.document.pages;
  const pageIds = pages.map((p) => p.id);

  const [sel, setSel] = useState<PagesSelection>(EMPTY_PAGES_SELECTION);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);

  // Panel selection survives page mutations by pruning stale ids each render.
  const selection = normalizePagesSelection(sel, pageIds);
  // The pages the action bar / context menu operate on: the panel selection,
  // falling back to the active page when nothing is selected here.
  const targets = selection.ids.length > 0 ? selection.ids : [activePage.id];
  const canDelete = targets.length < pages.length;

  // --- Batched page operations (one undo entry per user action) -------------
  const runBatch = (label: string, count: number, fn: () => void) => {
    if (count > 1) {
      service.beginTransaction(label);
      fn();
      service.commit();
    } else {
      fn();
    }
  };

  const insertBlankAfter = () => {
    const lastIndex = Math.max(...targets.map((id) => pageIds.indexOf(id)));
    const newId = service.insertBlankPage(lastIndex + 1);
    actions.setActivePage(newId);
    setSel({ ids: [newId], anchorId: newId });
    setFocusedId(newId);
  };

  const duplicateTargets = () => {
    const created: string[] = [];
    runBatch("Duplicate pages", targets.length, () => {
      for (const id of targets) {
        const newId = service.duplicatePage(id);
        if (newId) {
          created.push(newId);
          onPageDuplicated?.(id, newId);
        }
      }
    });
    if (created.length > 0) {
      actions.setActivePage(created[0]);
      setSel({ ids: created, anchorId: created[0] });
      setFocusedId(created[0]);
    }
  };

  const rotateTargets = (delta: 90 | -90) => {
    runBatch(delta > 0 ? "Rotate pages right" : "Rotate pages left", targets.length, () => {
      for (const id of targets) service.rotatePageBy(id, delta);
    });
  };

  const deleteTargets = () => {
    if (!canDelete) return;
    runBatch("Delete pages", targets.length, () => {
      for (const id of targets) service.deletePage(id);
    });
    setSel(EMPTY_PAGES_SELECTION);
  };

  const movePageBy = (page: EditorPage, index: number, delta: number) => {
    const to = Math.max(0, Math.min(index + delta, pages.length - 1));
    if (to !== index) service.movePage(page.id, to);
  };

  // --- Click / drag ----------------------------------------------------------
  const measureItems = (): MeasuredItem[] => {
    const list = listRef.current;
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLElement>("[data-page-id]")).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
  };

  const onItemPointerDown = (e: React.PointerEvent, page: EditorPage, index: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pageId: page.id,
      fromIndex: index,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      items: [],
      dropSlot: null,
    };
  };

  const onItemPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (
        Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX &&
        Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      d.active = true;
      d.items = measureItems();
      setDraggingId(d.pageId);
    }
    const slot = insertionIndexFromPointer(e.clientY, d.items);
    d.dropSlot = slot;
    setDropSlot(slot);
  };

  const endDrag = () => {
    setDraggingId(null);
    setDropSlot(null);
    dragRef.current = null;
  };

  const onItemPointerUp = (e: React.PointerEvent, page: EditorPage) => {
    const d = dragRef.current;
    if (d?.active) {
      if (d.dropSlot !== null) {
        const to = moveTargetIndex(d.fromIndex, d.dropSlot);
        if (to !== d.fromIndex) service.movePage(d.pageId, to);
      }
      endDrag();
      return;
    }
    dragRef.current = null;
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    setSel(reducePageClick(selection, pageIds, page.id, mods));
    setFocusedId(page.id);
    if (!mods.ctrl && !mods.shift) actions.setActivePage(page.id);
  };

  const focusPage = (id: string) => {
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  };

  const onItemKeyDown = (e: React.KeyboardEvent, page: EditorPage, index: number) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      if (ctrl) {
        // Ctrl+Arrow moves the PAGE within the document.
        movePageBy(page, index, delta);
        return;
      }
      const next = pages[index + delta];
      if (next) {
        setSel(reducePageClick(selection, pageIds, next.id, { shift: e.shiftKey }));
        actions.setActivePage(next.id);
        focusPage(next.id);
      }
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      const target = e.key === "Home" ? pages[0] : pages[pages.length - 1];
      setSel(reducePageClick(selection, pageIds, target.id, {}));
      actions.setActivePage(target.id);
      focusPage(target.id);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setSel(reducePageClick(selection, pageIds, page.id, { ctrl }));
      if (!ctrl) actions.setActivePage(page.id);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      // Delete the panel targets (falls back to this page via selection rules).
      if (!selection.ids.includes(page.id)) {
        if (pages.length > 1) service.deletePage(page.id);
        return;
      }
      deleteTargets();
      return;
    }
  };

  const onItemContextMenu = (e: React.MouseEvent, page: EditorPage) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selection.ids.includes(page.id)) {
      setSel({ ids: [page.id], anchorId: page.id });
      actions.setActivePage(page.id);
    }
    setFocusedId(page.id);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById("editor-pages-menu");
      if (el && !el.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const focusableId = focusedId !== null && pageIds.includes(focusedId) ? focusedId : activePage.id;
  const deleteTitle = canDelete
    ? `Delete ${targets.length > 1 ? `${targets.length} pages` : "page"}`
    : "A document must keep at least one page";

  return (
    <div className="flex h-full flex-col">
      {/*
        P1 Phase D3. The header used to expose FIVE tiny icon buttons
        (insert/duplicate/rotate-left/rotate-right/delete) permanently — a row of
        3.5px-icon targets, three of which are destructive or mutating, sitting
        above the thumbnails at all times. The brief's rule is "do not permanently
        expose a collection of tiny page-operation icons", and the deeper problem
        was that a mis-click on a 14px Trash2 next to a 14px RotateCw is a page
        the user did not mean to delete.
        Every one of those operations remains available — per page on hover (⋯),
        by right-click, and by keyboard — so nothing was removed, only unpinned.
      */}
      <div className="flex items-center justify-between border-b border-editor-border px-2.5 py-2">
        <h2 className="text-[13px] font-semibold text-editor-text">
          Pages
          <span className="ml-1.5 text-[11px] font-normal text-editor-muted">{pages.length}</span>
        </h2>
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-2.5 py-2.5"
        role="listbox"
        aria-label="Pages"
        aria-multiselectable="true"
      >
        {pages.map((page, i) => {
          const isActive = page.id === activePage.id;
          const isSelected = selection.ids.includes(page.id);
          const isDragging = draggingId === page.id;
          return (
            <div key={page.id}>
              {draggingId !== null && dropSlot === i ? <DropIndicator /> : null}
              <div
                ref={(el) => {
                  if (el) itemRefs.current.set(page.id, el);
                  else itemRefs.current.delete(page.id);
                }}
                data-page-id={page.id}
                role="option"
                aria-selected={isSelected || isActive}
                aria-label={`Page ${i + 1} of ${pages.length}${isActive ? ", current page" : ""}`}
                tabIndex={page.id === focusableId ? 0 : -1}
                title="Click to open — drag or Ctrl+Arrow to reorder"
                /*
                 * The premium thumbnail card (Phase D4/D5/L). A 12px radius, a
                 * hairline neutral border at rest, and a 2px accent ring + soft
                 * accent glow for the active page — the previous treatment gave
                 * the ACTIVE page and a merely-SELECTED page the same 2px ring at
                 * different opacities, which at thumbnail size was not a legible
                 * difference. Now: active = ring + glow, selected = accent-tinted
                 * surface, neither = hairline border.
                 */
                className={`group relative mb-2.5 cursor-pointer touch-none select-none rounded-appcard p-1.5 outline-none transition-[box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-editor-accent motion-reduce:transition-none ${
                  isActive
                    ? "bg-editor-surface ring-2 ring-editor-accent shadow-[0_0_0_4px_rgba(124,58,237,0.10),0_2px_8px_rgba(16,24,40,0.08)]"
                    : isSelected
                      ? "bg-editor-accentsoft ring-1 ring-editor-accent/40"
                      : "bg-editor-surface ring-1 ring-editor-border hover:ring-editor-accent/40 hover:shadow-appcard"
                } ${isDragging ? "opacity-60" : ""}`}
                onPointerDown={(e) => onItemPointerDown(e, page, i)}
                onPointerMove={onItemPointerMove}
                onPointerUp={(e) => onItemPointerUp(e, page)}
                onPointerCancel={endDrag}
                onKeyDown={(e) => onItemKeyDown(e, page, i)}
                onContextMenu={(e) => onItemContextMenu(e, page)}
                onFocus={() => setFocusedId(page.id)}
              >
                <PageThumbnail page={page} src={backgroundForPage(page.id)} pageNumber={i + 1} />

                {/* Per-page actions, revealed on hover/focus (Phase D6). Opens
                    the same menu right-click opens, so there is one page-action
                    surface rather than two that can disagree. */}
                <button
                  type="button"
                  aria-label={`Actions for page ${i + 1}`}
                  title="Page actions"
                  className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-control border border-editor-border bg-editor-surface/95 text-editor-muted opacity-0 shadow-appcard backdrop-blur transition-opacity hover:text-editor-text focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent group-hover:opacity-100 motion-reduce:transition-none"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setSel({ ids: [page.id], anchorId: page.id });
                    setFocusedId(page.id);
                    setMenu({ x: r.left, y: r.bottom + 4 });
                  }}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <span
                  className={`pointer-events-none absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                    isActive ? "bg-editor-accent text-white" : "bg-slate-900/55 text-white"
                  }`}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
              </div>
            </div>
          );
        })}
        {draggingId !== null && dropSlot === pages.length ? <DropIndicator /> : null}
      </div>

      {/* Add Page (Phase D7): the one page operation frequent enough to earn a
          permanent control, and the only non-destructive one. */}
      <div className="shrink-0 border-t border-editor-border p-2">
        <button
          type="button"
          onClick={insertBlankAfter}
          className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-control border border-dashed border-editor-borderstrong text-[12px] font-semibold text-editor-muted transition-colors hover:border-editor-accent/50 hover:bg-editor-accentsoft hover:text-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Page
        </button>
      </div>

      {menu ? (
        <div
          id="editor-pages-menu"
          role="menu"
          aria-label="Page actions"
          className="fixed z-50 min-w-48 rounded-md border border-editor-border bg-editor-surface py-1 text-sm shadow-appmenu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem label="Insert blank page after" onClick={() => { insertBlankAfter(); setMenu(null); }} />
          <MenuItem
            label={targets.length > 1 ? `Duplicate ${targets.length} pages` : "Duplicate page"}
            onClick={() => { duplicateTargets(); setMenu(null); }}
          />
          <div className="my-1 h-px bg-editor-subtle" role="separator" />
          <MenuItem label="Rotate left 90°" onClick={() => { rotateTargets(-90); setMenu(null); }} />
          <MenuItem label="Rotate right 90°" onClick={() => { rotateTargets(90); setMenu(null); }} />          <div className="my-1 h-px bg-editor-subtle" role="separator" />
          <MenuItem
            label={targets.length > 1 ? `Delete ${targets.length} pages` : "Delete page"}
            disabled={!canDelete}
            title={deleteTitle}
            onClick={() => {
              if (!canDelete) return;
              deleteTargets();
              setMenu(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A page thumbnail. The raster background is stored in UNROTATED page space,
 * so the wrapper takes the ROTATED aspect and the inner <img> is CSS-rotated
 * into it — the thumbnail always shows the page exactly as the canvas and the
 * exported PDF display it. Pages without a background render as a white page
 * with a large page number.
 */
function PageThumbnail({ page, src, pageNumber }: { page: EditorPage; src: string | undefined; pageNumber: number }) {
  const display = rotatedPageSize(page.rotation, { width: page.width, height: page.height });
  const hasImage = Boolean(src);
  return (
    <div
      className="relative w-full overflow-hidden rounded-sm border border-editor-border bg-editor-page shadow-appcard"
      style={{ aspectRatio: `${display.width} / ${display.height}` }}
    >
      {hasImage ? (
        // A plain <img> is right here: the src is an in-memory data URL page
        // raster (SignTool does the same) — next/image adds nothing for those.
        <img
          src={src}
          alt=""
          draggable={false}
          style={thumbImageStyle(page.rotation, page.width, page.height)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-semibold text-editor-border" aria-hidden="true">
            {pageNumber}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Sizes + rotates the unrotated page raster into a wrapper that has the
 * ROTATED aspect ratio. At 90/270 the image's box is the wrapper's box with
 * the axes swapped, which in percentages of the wrapper is width = (w/h)·100%
 * and height = (h/w)·100% (each axis resolves against the wrapper's own axis).
 */
function thumbImageStyle(rotation: 0 | 90 | 180 | 270, pageWidth: number, pageHeight: number): React.CSSProperties {
  if (rotation === 90 || rotation === 270) {
    return {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: `${(pageWidth / pageHeight) * 100}%`,
      height: `${(pageHeight / pageWidth) * 100}%`,
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    };
  }
  return {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    transform: rotation === 180 ? "rotate(180deg)" : undefined,
  };
}

function DropIndicator() {
  return <div className="pointer-events-none mb-2 h-0.5 rounded bg-editor-accent" aria-hidden="true" />;
}

function MenuItem({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      role="menuitem"
      className={`flex w-full items-center px-3 py-1.5 text-left outline-none focus-visible:bg-editor-accentsoft ${
        disabled ? "cursor-not-allowed text-editor-border" : "text-editor-text hover:bg-editor-accentsoft"
      }`}
      onClick={onClick}
      aria-disabled={disabled || undefined}
      title={title}
    >
      {label}
    </button>
  );
}
