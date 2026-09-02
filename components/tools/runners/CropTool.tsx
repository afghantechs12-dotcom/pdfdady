"use client";

import { useEffect, useRef, useState } from "react";
import { Crop } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { PdfPreview, type PreviewDims } from "@/components/pdf/PdfPreview";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { cropPdf } from "@/lib/pdf/crop";

const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];
type Margins = Record<Side, number>;

export function CropTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];
  const { doc, status: docStatus } = usePdfDocument(file);

  const [margins, setMargins] = useState<Margins>({
    top: 20,
    right: 20,
    bottom: 20,
    left: 20,
  });
  // Visual page dimensions (points) of page 1, used to map points <-> screen px.
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    if (!doc) {
      setPageDims(null);
      return;
    }
    doc.getPage(1).then((page) => {
      if (!active) return;
      const vp = page.getViewport({ scale: 1, rotation: page.rotate });
      setPageDims({ w: vp.width, h: vp.height });
    });
    return () => {
      active = false;
    };
  }, [doc]);

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

  const setSide = (side: Side, value: number) =>
    setMargins((m) => ({ ...m, [side]: Math.max(0, value) }));

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
          <div className="rounded-xl border border-softborder bg-lavender/40 p-4">
            <p className="text-sm font-medium text-navy">
              Crop margins (in points, applied to every page)
            </p>
            <p className="mt-1 text-xs text-navy-soft">
              Drag the edges on the preview, or type exact values below.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {SIDES.map((side) => (
                <label key={side} className="text-sm text-navy-soft">
                  <span className="mb-1 block font-medium capitalize">
                    {side}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={margins[side]}
                    onChange={(e) => setSide(side, Number(e.target.value) || 0)}
                    className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              ))}
            </div>
          </div>

          {/* Live preview with draggable crop rectangle */}
          <div className="flex items-start justify-center rounded-xl border border-softborder bg-neutral-50 p-3">
            {docStatus === "ready" && pageDims ? (
              <PdfPreview file={file} pageIndex={0} width={380}>
                {(dims) => (
                  <CropOverlay
                    dims={dims}
                    pageDims={pageDims}
                    margins={margins}
                    onChange={setMargins}
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
          leadingIcon={<Crop size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || proc.status === "processing"}
          onClick={() => proc.run(() => cropPdf(file, margins), file)}
        >
          {proc.status === "processing" ? "Cropping…" : "Crop PDF"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Draggable crop rectangle overlaid on the rendered page. Margins are in PDF
 * points and map to screen pixels by `scale = dims.width / pageDims.w`. Because
 * the crop model's top/bottom already match the visual top/bottom of the page,
 * screen space (top-left origin) needs no vertical flip here.
 */
function CropOverlay({
  dims,
  pageDims,
  margins,
  onChange,
}: {
  dims: PreviewDims;
  pageDims: { w: number; h: number };
  margins: Margins;
  onChange: (m: Margins) => void;
}) {
  const scale = dims.width / pageDims.w;
  const marginsRef = useRef(margins);
  marginsRef.current = margins;

  const startDrag = (side: Side) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Capture the overlay element now: React nulls e.currentTarget once this
    // handler returns, so it must not be read inside the window listeners.
    const overlay = (e.currentTarget as HTMLElement).parentElement!;

    const move = (ev: PointerEvent) => {
      const rect = overlay.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const next = { ...marginsRef.current };
      if (side === "left") {
        next.left = clamp(px / scale, 0, pageDims.w - margins.right - 10);
      } else if (side === "right") {
        next.right = clamp(
          (dims.width - px) / scale,
          0,
          pageDims.w - margins.left - 10,
        );
      } else if (side === "top") {
        next.top = clamp(py / scale, 0, pageDims.h - margins.bottom - 10);
      } else {
        next.bottom = clamp(
          (dims.height - py) / scale,
          0,
          pageDims.h - margins.top - 10,
        );
      }
      onChange(next);
    };
    const up = (ev: PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const l = margins.left * scale;
  const t = margins.top * scale;
  const r = dims.width - margins.right * scale;
  const b = dims.height - margins.bottom * scale;

  return (
    <>
      {/* Dimmed trimmed area (four bars) */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute bg-navy/40"
          style={{ left: 0, top: 0, width: dims.width, height: t }}
        />
        <div
          className="absolute bg-navy/40"
          style={{ left: 0, top: b, width: dims.width, height: dims.height - b }}
        />
        <div
          className="absolute bg-navy/40"
          style={{ left: 0, top: t, width: l, height: b - t }}
        />
        <div
          className="absolute bg-navy/40"
          style={{ left: r, top: t, width: dims.width - r, height: b - t }}
        />
      </div>

      {/* Crop frame */}
      <div
        className="pointer-events-none absolute border-2 border-primary"
        style={{ left: l, top: t, width: r - l, height: b - t }}
      />

      {/* Edge handles */}
      <EdgeHandle orientation="h" pos={{ left: l, top: t, width: r - l }} onPointerDown={startDrag("top")} />
      <EdgeHandle orientation="h" pos={{ left: l, top: b, width: r - l }} onPointerDown={startDrag("bottom")} />
      <EdgeHandle orientation="v" pos={{ left: l, top: t, height: b - t }} onPointerDown={startDrag("left")} />
      <EdgeHandle orientation="v" pos={{ left: r, top: t, height: b - t }} onPointerDown={startDrag("right")} />
    </>
  );
}

function EdgeHandle({
  orientation,
  pos,
  onPointerDown,
}: {
  orientation: "h" | "v";
  pos: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={
        "absolute touch-none bg-primary/70 hover:bg-primary " +
        (orientation === "h"
          ? "h-1.5 -translate-y-1/2 cursor-ns-resize"
          : "w-1.5 -translate-x-1/2 cursor-ew-resize")
      }
      style={pos}
    />
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
