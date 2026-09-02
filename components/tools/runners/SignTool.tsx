"use client";

import { useEffect, useRef, useState } from "react";
import { PenTool } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { PdfPreview, type PreviewDims } from "@/components/pdf/PdfPreview";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { signPdf } from "@/lib/pdf/sign";

export function SignTool() {
  const pdfUpload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const sigUpload = useFileUpload({
    accept: ["image/png", "image/jpeg"],
    multiple: false,
  });
  const proc = usePdfProcessor({ fileCount: pdfUpload.files.length });

  const file = pdfUpload.files[0];
  const sig = sigUpload.files[0];
  const { doc, pageCount, status: docStatus } = usePdfDocument(file);

  const [pageIndex, setPageIndex] = useState(0);
  // Fractions against the DISPLAYED page. y is the bottom edge, from the bottom.
  const [xFrac, setXFrac] = useState(0.6);
  const [yFrac, setYFrac] = useState(0.1);
  const [widthFrac, setWidthFrac] = useState(0.3);

  // Object URL + aspect ratio of the signature image, for the preview box.
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [sigAspect, setSigAspect] = useState(3); // width / height

  useEffect(() => setPageIndex(0), [file]);

  useEffect(() => {
    if (!sig) {
      setSigUrl(null);
      return;
    }
    const url = URL.createObjectURL(sig);
    setSigUrl(url);
    const img = new Image();
    img.onload = () => setSigAspect(img.width / img.height || 3);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [sig]);

  if (proc.status === "done" && proc.result) {
    return (
      <ResultActions
        result={proc.result}
        onReset={() => {
          proc.reset();
          pdfUpload.reset();
          sigUpload.reset();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-navy">1. Your PDF</p>
          <UploadDropzone
            accept={["application/pdf"]}
            files={pdfUpload.files}
            errors={pdfUpload.errors}
            onAddFiles={pdfUpload.addFiles}
            onRemoveFile={pdfUpload.removeFile}
            title="Drop your PDF here"
            subtitle="or click to browse"
            acceptHint="Select one PDF · Max 50MB"
          />
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-navy">
            2. Signature image
          </p>
          <UploadDropzone
            accept={["image/png", "image/jpeg"]}
            files={sigUpload.files}
            errors={sigUpload.errors}
            onAddFiles={sigUpload.addFiles}
            onRemoveFile={sigUpload.removeFile}
            title="Drop your signature image"
            subtitle="or click to browse"
            trustText="PNG with transparent background works best"
            acceptHint="PNG or JPG · Max 50MB"
          />
        </div>
      </div>

      {file && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          {/* Controls */}
          <div className="space-y-4 rounded-xl border border-softborder bg-lavender/40 p-4">
            <p className="text-sm font-medium text-navy">
              Drag the signature on the preview to position it, and drag the
              corner to resize.
            </p>
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
            <div className="grid grid-cols-3 gap-3">
              <NumField label="X (%)" value={xFrac} onChange={setXFrac} />
              <NumField label="Y (%)" value={yFrac} onChange={setYFrac} />
              <NumField
                label="Width (%)"
                value={widthFrac}
                min={5}
                onChange={setWidthFrac}
              />
            </div>
            <p className="text-xs text-navy-soft">
              This adds a visual signature image. It is not a cryptographic
              digital signature.
            </p>
          </div>

          {/* Live preview */}
          <div className="flex items-start justify-center rounded-xl border border-softborder bg-neutral-50 p-3">
            {docStatus === "ready" && doc ? (
              <PdfPreview file={file} pageIndex={pageIndex} width={380}>
                {(dims) => (
                  <SignatureBox
                    dims={dims}
                    xFrac={xFrac}
                    yFrac={yFrac}
                    widthFrac={widthFrac}
                    aspect={sigAspect}
                    imageUrl={sigUrl}
                    onMove={(x, y) => {
                      setXFrac(x);
                      setYFrac(y);
                    }}
                    onResize={setWidthFrac}
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

      <Button
        size="lg"
        fullWidth
        leadingIcon={<PenTool size={18} />}
        loading={proc.status === "processing"}
        disabled={!file || !sig || proc.status === "processing"}
        onClick={() =>
          proc.run(
            () => signPdf(file, sig, { pageIndex, xFrac, yFrac, widthFrac }),
            file,
          )
        }
      >
        {proc.status === "processing" ? "Signing…" : "Sign PDF"}
      </Button>
    </div>
  );
}

/**
 * Draggable + resizable signature box. Anchor semantics match sign.ts: xFrac is
 * the left edge, yFrac is the BOTTOM edge measured from the page bottom, so the
 * box's screen top = height - (yFrac*height) - boxHeight.
 */
function SignatureBox({
  dims,
  xFrac,
  yFrac,
  widthFrac,
  aspect,
  imageUrl,
  onMove,
  onResize,
}: {
  dims: PreviewDims;
  xFrac: number;
  yFrac: number;
  widthFrac: number;
  aspect: number;
  imageUrl: string | null;
  onMove: (xFrac: number, yFrac: number) => void;
  onResize: (widthFrac: number) => void;
}) {
  const boxW = widthFrac * dims.width;
  const boxH = boxW / aspect;
  const left = xFrac * dims.width;
  const top = dims.height - yFrac * dims.height - boxH;

  const state = useRef({ mode: "" as "move" | "resize" | "" });

  const onPointerMove = (e: React.PointerEvent) => {
    if (!state.current.mode) return;
    const parent = (e.currentTarget as HTMLElement).parentElement!;
    const rect = parent.getBoundingClientRect();
    if (state.current.mode === "move") {
      const px = clamp01((e.clientX - rect.left) / dims.width);
      const pyTop = (e.clientY - rect.top) / dims.height;
      // pointer sets the box top; convert box bottom to yFrac-from-bottom
      const bottomFromTop = pyTop + boxH / dims.height;
      onMove(clamp01(px), clamp01(1 - bottomFromTop));
    } else {
      const w = clamp01((e.clientX - rect.left - left) / dims.width);
      onResize(Math.max(0.05, w));
    }
  };
  const start = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    state.current.mode = mode;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const end = (e: React.PointerEvent) => {
    state.current.mode = "";
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      onPointerDown={start("move")}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      className="absolute cursor-move touch-none border-2 border-dashed border-primary bg-primary/5"
      style={{ left, top, width: boxW, height: boxH }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Signature"
          className="pointer-events-none h-full w-full object-contain"
        />
      ) : (
        <span className="pointer-events-none flex h-full items-center justify-center text-[10px] text-primary">
          signature
        </span>
      )}
      <div
        onPointerDown={start("resize")}
        onPointerUp={end}
        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-full border border-white bg-primary"
      />
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <label className="text-sm text-navy-soft">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        type="number"
        min={min}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) =>
          onChange(clamp01(Math.max(min, Number(e.target.value) || 0) / 100))
        }
        className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
