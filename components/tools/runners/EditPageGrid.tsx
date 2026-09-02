"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reorder } from "framer-motion";
import {
  RotateCw,
  Trash2,
  ArrowLeft,
  ArrowRight,
  GripVertical,
  Loader2,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfPreview } from "@/components/pdf/PdfPreview";
import type { EditPage } from "@/lib/pdf/edit";

export interface PageEntry extends EditPage {
  id: string; // stable key for the list
}

const THUMB_WIDTH = 150;
/**
 * Above this page count the grid is treated as a "large document": thumbnails
 * render lazily as they scroll into view (LazyThumbnail) and a notice tells the
 * user why. Below it every thumbnail mounts eagerly (small docs feel instant).
 */
export const LARGE_DOC_THRESHOLD = 30;

/**
 * Renders its children (a PdfPreview canvas — the expensive part) only once the
 * wrapper scrolls near the viewport, then keeps it mounted. The reserved
 * `minHeight` (an A4-portrait estimate) keeps off-screen cards laid out below
 * the fold so the IntersectionObserver doesn't fire for all of them at once.
 *
 * This is virtualization of the costly render: a 200-page document no longer
 * rasterizes 200 pages up front — only the visible ~dozen do, the rest as you
 * scroll. The cheap Reorder cards (border + buttons) stay rendered so drag,
 * rotate, and delete work on every page regardless of whether its thumbnail has
 * rasterized yet.
 */
function LazyThumbnail({
  width,
  lazy,
  children,
}: {
  width: number;
  lazy: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);

  useEffect(() => {
    if (!lazy || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" }, // pre-rasterize a bit before it scrolls in
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-md border border-softborder/70 bg-lavender/30"
      style={{ width, minHeight: Math.round(width * 1.414) }}
    >
      {visible ? (
        children
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-navy-soft/60">
          <Loader2 size={20} className="animate-spin" aria-label="Loading preview" />
        </div>
      )}
    </div>
  );
}

/**
 * The drag-to-reorder page grid, split into its own module so framer-motion
 * (~110 KB) is loaded lazily AFTER a document is opened — not on initial page
 * load of the five tool routes that render EditTool. Thumbnails render lazily
 * (LazyThumbnail) for large documents so opening a 200-page PDF doesn't
 * rasterize every page at once.
 */
export function EditPageGrid({
  doc,
  pages,
  onReorder,
  onMove,
  onRotate,
  onRemove,
}: {
  doc: PDFDocumentProxy;
  pages: PageEntry[];
  onReorder: (pages: PageEntry[]) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRotate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const lazy = pages.length > LARGE_DOC_THRESHOLD;

  return (
    <Reorder.Group
      axis="y"
      values={pages}
      onReorder={onReorder}
      className="mt-4 flex flex-wrap gap-4"
    >
      {pages.map((page, index) => (
        <Reorder.Item
          key={page.id}
          value={page}
          className="group relative flex cursor-grab flex-col items-center gap-2 rounded-xl border border-softborder bg-white p-2 shadow-card active:cursor-grabbing"
          style={{ width: THUMB_WIDTH + 16 }}
          whileDrag={{ scale: 1.04, zIndex: 10 }}
        >
          <div className="relative">
            <LazyThumbnail width={THUMB_WIDTH} lazy={lazy}>
              <PdfPreview
                doc={doc}
                pageIndex={page.originalIndex}
                rotation={page.rotation}
                width={THUMB_WIDTH}
                className="pointer-events-none"
              />
            </LazyThumbnail>
            <span className="absolute left-1 top-1 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-navy/80 px-1.5 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <span className="absolute right-1 top-1 text-navy-soft/70">
              <GripVertical size={16} />
            </span>
          </div>

          <div className="flex items-center justify-center gap-1">
            <IconBtn
              label={`Move page ${index + 1} left`}
              onClick={() => onMove(index, -1)}
              disabled={index === 0}
            >
              <ArrowLeft size={15} />
            </IconBtn>
            <IconBtn
              label={`Rotate page ${index + 1}`}
              onClick={() => onRotate(page.id)}
            >
              <RotateCw size={15} />
            </IconBtn>
            <IconBtn
              label={`Delete page ${index + 1}`}
              onClick={() => onRemove(page.id)}
              variant="danger"
            >
              <Trash2 size={15} />
            </IconBtn>
            <IconBtn
              label={`Move page ${index + 1} right`}
              onClick={() => onMove(index, 1)}
              disabled={index === pages.length - 1}
            >
              <ArrowRight size={15} />
            </IconBtn>
          </div>
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  variant = "default",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={disabled}
      className={
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft transition-colors disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 " +
        (variant === "danger"
          ? "hover:bg-red-50 hover:text-red-600"
          : "hover:bg-lavender hover:text-primary")
      }
    >
      {children}
    </button>
  );
}
