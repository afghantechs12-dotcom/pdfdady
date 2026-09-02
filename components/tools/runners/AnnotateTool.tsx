"use client";

import { useEffect, useRef, useState } from "react";
import { Highlighter } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { PdfPreview, type PreviewDims } from "@/components/pdf/PdfPreview";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { annotatePdf } from "@/lib/pdf/annotate";

export function AnnotateTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];
  const { doc, pageCount, status: docStatus } = usePdfDocument(file);

  const [text, setText] = useState("Sample note");
  const [pageIndex, setPageIndex] = useState(0);
  // Position as fractions of the DISPLAYED page (xFrac from left, yFrac from bottom).
  const [xFrac, setXFrac] = useState(0.1);
  const [yFrac, setYFrac] = useState(0.9);

  useEffect(() => {
    setPageIndex(0);
  }, [file]);

  if (proc.status === "done" && proc.result) {
    return (
      <ResultActions
        result={proc.result}
        onReset={() => {
          proc.reset();
          upload.reset();
        }}
      />
    );
  }

  return (
    <div>
      <UploadDropzone
        accept={["application/pdf"]}
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={upload.removeFile}
        title="Drop your PDF here"
        subtitle="or click to browse"
        acceptHint="Select one PDF · Max 50MB"
      />

      {file && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          {/* Controls */}
          <div className="space-y-4 rounded-xl border border-softborder bg-lavender/40 p-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-navy">Note text</span>
              <textarea
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                className="w-full rounded-button border border-softborder bg-white px-3 py-2 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>

            {pageCount > 1 && (
              <label className="block text-sm text-navy-soft">
                <span className="mb-1 block font-medium">Page</span>
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={pageIndex + 1}
                  onChange={(e) =>
                    setPageIndex(
                      Math.min(
                        Math.max(0, Number(e.target.value) - 1),
                        pageCount - 1,
                      ),
                    )
                  }
                  className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none sm:w-32"
                />
              </label>
            )}

            <p className="text-xs text-navy-soft">
              Drag the note on the preview to position it, or set X/Y precisely:
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-navy-soft">
                <span className="mb-1 block font-medium">X position (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(xFrac * 100)}
                  onChange={(e) =>
                    setXFrac(clamp01((Number(e.target.value) || 0) / 100))
                  }
                  className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="text-sm text-navy-soft">
                <span className="mb-1 block font-medium">Y position (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(yFrac * 100)}
                  onChange={(e) =>
                    setYFrac(clamp01((Number(e.target.value) || 0) / 100))
                  }
                  className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
            </div>
          </div>

          {/* Live preview with draggable note */}
          <div className="flex items-start justify-center rounded-xl border border-softborder bg-neutral-50 p-3">
            {docStatus === "ready" && doc ? (
              <PdfPreview file={file} pageIndex={pageIndex} width={380}>
                {(dims) => (
                  <DraggableMarker
                    dims={dims}
                    xFrac={xFrac}
                    yFrac={yFrac}
                    onChange={(x, y) => {
                      setXFrac(x);
                      setYFrac(y);
                    }}
                    label={text || "Note"}
                  />
                )}
              </PdfPreview>
            ) : (
              <p className="py-10 text-sm text-navy-soft">Loading preview…</p>
            )}
          </div>
        </div>
      )}

      {proc.status === "error" && proc.error && (
        <ErrorBanner message={proc.error.message} />
      )}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Highlighter size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || !text.trim() || proc.status === "processing"}
          onClick={() =>
            proc.run(
              () =>
                annotatePdf(file, {
                  pageIndex,
                  text,
                  xFrac,
                  yFrac,
                  fontSize: 14,
                }),
              file,
            )
          }
        >
          {proc.status === "processing" ? "Adding note…" : "Add Note"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A draggable marker over the rendered page. Screen space is TOP-LEFT origin;
 * the reported yFrac uses pdf-lib's BOTTOM-LEFT origin, hence
 * `yFrac = 1 - top/height`.
 */
function DraggableMarker({
  dims,
  xFrac,
  yFrac,
  onChange,
  label,
}: {
  dims: PreviewDims;
  xFrac: number;
  yFrac: number;
  onChange: (xFrac: number, yFrac: number) => void;
  label: string;
}) {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const parent = (e.currentTarget as HTMLElement).parentElement!;
    const rect = parent.getBoundingClientRect();
    const px = clamp01((e.clientX - rect.left) / dims.width);
    const py = clamp01((e.clientY - rect.top) / dims.height);
    onChange(px, 1 - py); // flip Y to bottom-left origin
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const left = xFrac * dims.width;
  const top = (1 - yFrac) * dims.height;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute max-w-[70%] -translate-y-full cursor-move touch-none select-none whitespace-pre rounded bg-red-600/90 px-1.5 py-0.5 text-xs font-medium text-white shadow"
      style={{ left, top }}
    >
      {label.slice(0, 40) || "Note"}
    </div>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
