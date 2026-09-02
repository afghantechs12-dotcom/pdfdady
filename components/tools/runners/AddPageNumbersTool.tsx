"use client";

import { useState } from "react";
import { Hash } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import {
  addPageNumbers,
  type PageNumberPosition,
} from "@/lib/pdf/addPageNumbers";
import { cn } from "@/lib/utils/cn";

export function AddPageNumbersTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];

  const [position, setPosition] = useState<PageNumberPosition>("bottom-center");
  const [showTotal, setShowTotal] = useState(true);

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
        <div className="mt-6 rounded-xl border border-softborder bg-lavender/40 p-4">
          <p className="text-sm font-medium text-navy">Options</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(
              [
                ["bottom-center", "Bottom center"],
                ["bottom-right", "Bottom right"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPosition(value)}
                className={cn(
                  "rounded-button border px-3 py-2 text-sm font-medium transition-colors",
                  position === value
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-softborder bg-white text-navy-soft hover:border-primary/40",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-navy-soft">
            <input
              type="checkbox"
              checked={showTotal}
              onChange={(e) => setShowTotal(e.target.checked)}
              className="h-4 w-4 rounded border-softborder text-primary focus:ring-primary"
            />
            Show total pages (e.g. 1 / 10)
          </label>
        </div>
      )}

      {file && (
        <div className="mt-4 flex justify-center rounded-xl border border-softborder bg-neutral-50 p-3">
          <PdfViewer file={file} width={340} />
        </div>
      )}

      {proc.status === "error" && proc.error && <ErrorBanner message={proc.error.message} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Hash size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || proc.status === "processing"}
          onClick={() =>
            proc.run(() => addPageNumbers(file, { position, showTotal }), file)
          }
        >
          {proc.status === "processing" ? "Adding…" : "Add Page Numbers"}
        </Button>
      </div>
    </div>
  );
}
