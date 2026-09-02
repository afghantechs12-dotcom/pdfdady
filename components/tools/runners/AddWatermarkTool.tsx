"use client";

import { useState } from "react";
import { Stamp } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { addWatermark } from "@/lib/pdf/addWatermark";

export function AddWatermarkTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];
  const [text, setText] = useState("CONFIDENTIAL");

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
          <label
            htmlFor="watermark-text"
            className="text-sm font-medium text-navy"
          >
            Watermark text
          </label>
          <input
            id="watermark-text"
            type="text"
            maxLength={60}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-2 h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="mt-2 text-xs text-navy-soft">
            Applied diagonally across every page.
          </p>
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
          leadingIcon={<Stamp size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || !text.trim() || proc.status === "processing"}
          onClick={() => proc.run(() => addWatermark(file, text), file)}
        >
          {proc.status === "processing" ? "Applying…" : "Add Watermark"}
        </Button>
      </div>
    </div>
  );
}
