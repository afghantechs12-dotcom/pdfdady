"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PdfPreview } from "@/components/pdf/PdfPreview";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { cn } from "@/lib/utils/cn";

interface PdfViewerProps {
  file: File;
  /** Controlled page (0-based). When omitted the viewer manages its own. */
  page?: number;
  onPageChange?: (page: number) => void;
  width?: number;
  className?: string;
}

/**
 * Read-only PDF viewer with simple page navigation. A thin wrapper over
 * <PdfPreview> for tools that just want to show the document (rotate, watermark,
 * page numbers, split, metadata, forms).
 */
export function PdfViewer({
  file,
  page,
  onPageChange,
  width = 380,
  className,
}: PdfViewerProps) {
  const { pageCount, status, error } = usePdfDocument(file);
  const [internal, setInternal] = useState(0);
  const current = page ?? internal;

  // Clamp if the document shrinks or changes.
  useEffect(() => {
    if (pageCount > 0 && current > pageCount - 1) {
      (onPageChange ?? setInternal)(pageCount - 1);
    }
  }, [pageCount, current, onPageChange]);

  const go = (delta: number) => {
    const next = Math.min(Math.max(0, current + delta), pageCount - 1);
    (onPageChange ?? setInternal)(next);
  };

  // Only offer navigation when the viewer owns the page, or the caller opted in
  // via onPageChange. A page that's controlled without a handler is fixed.
  const navigable = page === undefined || onPageChange !== undefined;

  if (status === "error") {
    return (
      <p
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 px-3 py-4 text-center text-sm text-red-700"
      >
        {error}
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <PdfPreview file={file} pageIndex={current} width={width} />

      {pageCount > 1 && navigable && (
        <div className="flex items-center gap-3 text-sm text-navy-soft">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={current === 0}
            aria-label="Previous page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft transition-colors hover:bg-lavender hover:text-primary disabled:opacity-30"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="tabular-nums">
            Page {current + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={current >= pageCount - 1}
            aria-label="Next page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft transition-colors hover:bg-lavender hover:text-primary disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
