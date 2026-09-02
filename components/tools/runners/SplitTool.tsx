"use client";

import { useEffect, useState } from "react";
import { Scissors } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { splitPdf, getPageCount } from "@/lib/pdf/split";
import { pageRangeSchema } from "@/lib/validation/fileSchemas";

export function SplitTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });

  const [pageCount, setPageCount] = useState<number | null>(null);
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("1");
  const [rangeError, setRangeError] = useState<string | null>(null);

  const file = upload.files[0];

  useEffect(() => {
    let active = true;
    if (!file) {
      setPageCount(null);
      return;
    }
    getPageCount(file)
      .then((count) => {
        if (!active) return;
        setPageCount(count);
        setFrom("1");
        setTo(String(count));
      })
      .catch(() => {
        if (active) setPageCount(null);
      });
    return () => {
      active = false;
    };
  }, [file]);

  if (proc.status === "done" && proc.result) {
    return (
      <ResultActions
        result={proc.result}
        onReset={() => {
          proc.reset();
          upload.reset();
          setPageCount(null);
        }}
      />
    );
  }

  const handleSplit = () => {
    setRangeError(null);
    const parsed = pageRangeSchema.safeParse({
      from: Number(from),
      to: Number(to),
    });
    if (!parsed.success) {
      setRangeError(parsed.error.issues[0]?.message ?? "Invalid page range.");
      return;
    }
    proc.run(() => splitPdf(file, parsed.data), file);
  };

  return (
    <div>
      <UploadDropzone
        accept={["application/pdf"]}
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={(i) => {
          upload.removeFile(i);
          setPageCount(null);
        }}
        title="Drop your PDF here"
        subtitle="or click to browse"
        acceptHint="Select one PDF · Max 50MB"
      />

      {file && pageCount !== null && (
        <div className="mt-6 rounded-xl border border-softborder bg-lavender/40 p-4">
          <p className="text-sm font-medium text-navy">
            This PDF has {pageCount} page{pageCount === 1 ? "" : "s"}. Choose the
            range to extract:
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <label className="text-sm text-navy-soft">
              <span className="mb-1 block font-medium">From page</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 w-24 rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="text-sm text-navy-soft">
              <span className="mb-1 block font-medium">To page</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 w-24 rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
          </div>
        </div>
      )}

      {file && pageCount !== null && (
        <div className="mt-4 flex flex-col items-center gap-1 rounded-xl border border-softborder bg-neutral-50 p-3">
          <p className="text-xs font-medium text-navy-soft">
            Preview of start page {from}
          </p>
          <PdfViewer
            file={file}
            width={340}
            page={Math.min(
              Math.max(0, (Number(from) || 1) - 1),
              pageCount - 1,
            )}
          />
        </div>
      )}

      {(rangeError || (proc.status === "error" && proc.error)) && <ErrorBanner message={rangeError ?? proc.error?.message ?? ""} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Scissors size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || pageCount === null || proc.status === "processing"}
          onClick={handleSplit}
        >
          {proc.status === "processing" ? "Splitting…" : "Split PDF"}
        </Button>
      </div>
    </div>
  );
}
