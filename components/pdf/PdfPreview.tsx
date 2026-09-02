"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Loader2, AlertCircle } from "lucide-react";
import {
  getPdfDoc,
  retainPdfDoc,
  releasePdfDoc,
  renderPageToCanvas,
  isRenderCancelled,
} from "@/lib/pdf/render";
import { PdfProcessingError } from "@/lib/pdf/types";
import { cn } from "@/lib/utils/cn";

/** Rendered page dimensions in CSS pixels, handed to the overlay render-prop. */
export interface PreviewDims {
  width: number;
  height: number;
}

interface PdfPreviewProps {
  /** Source file, OR a pre-loaded doc (pass one). */
  file?: File;
  doc?: PDFDocumentProxy;
  /** 0-based page index to render. */
  pageIndex: number;
  /** Extra rotation in degrees added on top of the page's own /Rotate. */
  rotation?: number;
  /** Target displayed width in CSS px. Defaults to the container's width. */
  width?: number;
  className?: string;
  /**
   * Overlay render-prop. Receives the rendered page dimensions so markers can be
   * positioned in screen space. IMPORTANT coordinate contract: screen origin is
   * TOP-LEFT, while pdf-lib (the writer) uses a BOTTOM-LEFT origin. Convert a
   * marker's top offset to pdf-lib space with: yFrac = 1 - (markerTop / height).
   */
  children?: (dims: PreviewDims) => ReactNode;
}

/**
 * Rasterizes one PDF page to a <canvas> via PDF.js and layers an optional
 * overlay on top. The page is re-rasterized only when (file/doc, pageIndex,
 * rotation, width) changes — NOT on every parent re-render — so dragging a
 * marker (which only moves the lightweight overlay) never triggers a re-render
 * of the canvas.
 */
export function PdfPreview({
  file,
  doc: docProp,
  pageIndex,
  rotation = 0,
  width,
  className,
  children,
}: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<PreviewDims | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(
    width ?? null,
  );

  // Measure the container so the page renders at its natural displayed width
  // when no explicit width is given — and so an explicit width can be CLAMPED
  // to the container, or a fixed 380px canvas overflows small phones.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const available = el.clientWidth || 320;
      setMeasuredWidth(width != null ? Math.min(width, available) : available);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // When loading by File (no pre-loaded doc), hold a reference for the
  // lifetime of this preview so the ref-counted cache doesn't destroy the
  // worker-side document out from under us (see lib/pdf/render.ts).
  useEffect(() => {
    if (docProp || !file) return;
    retainPdfDoc(file).catch(() => undefined);
    return () => releasePdfDoc(file);
  }, [file, docProp]);

  useEffect(() => {
    let cancelled = false;
    let renderCancel: (() => void) | null = null;
    const targetWidth = measuredWidth;
    if (!targetWidth) return;

    setStatus("loading");
    setError(null);

    (async () => {
      try {
        const doc = docProp ?? (file ? await getPdfDoc(file) : null);
        if (!doc) {
          // Our own invariant, not anything about the file: the render helper
          // resolved without a document. `internal_error` is the honest class.
          throw new PdfProcessingError("No PDF to preview.", "internal_error");
        }
        if (cancelled) return;

        const safeIndex = Math.min(Math.max(pageIndex, 0), doc.numPages - 1);
        const page = await doc.getPage(safeIndex + 1);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const result = await renderPageToCanvas(
          page,
          canvas,
          targetWidth,
          rotation,
        );
        renderCancel = result.cancel;
        await result.done;
        if (cancelled) return;

        setDims({ width: result.cssWidth, height: result.cssHeight });
        setStatus("ready");
      } catch (err) {
        if (cancelled || isRenderCancelled(err)) return;
        setStatus("error");
        setError(
          err instanceof PdfProcessingError
            ? err.message
            : "We couldn't render this page.",
        );
      }
    })();

    return () => {
      cancelled = true;
      // Cancel an in-flight render (StrictMode double-mount, rapid page/rotation
      // switches). The rejection is swallowed above via isRenderCancelled.
      renderCancel?.();
    };
  }, [file, docProp, pageIndex, rotation, measuredWidth]);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      style={dims ? { height: dims.height } : undefined}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          "block rounded-lg",
          status === "ready" ? "opacity-100" : "opacity-0",
        )}
      />

      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-lavender/40 text-primary">
          <Loader2 className="animate-spin" size={22} aria-label="Loading preview" />
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-4 text-center text-sm text-red-700">
          <AlertCircle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Overlay markers, positioned in screen space over the rendered page. */}
      {status === "ready" && dims && children && (
        <div
          className="absolute left-0 top-0"
          style={{ width: dims.width, height: dims.height }}
        >
          {children(dims)}
        </div>
      )}
    </div>
  );
}
