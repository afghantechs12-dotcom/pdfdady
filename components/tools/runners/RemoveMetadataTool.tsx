"use client";

import { Eraser } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { removeMetadata } from "@/lib/pdf/removeMetadata";

export function RemoveMetadataTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];

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
        <div className="mt-4 flex justify-center rounded-xl border border-softborder bg-neutral-50 p-3">
          <PdfViewer file={file} width={340} />
        </div>
      )}

      {proc.status === "error" && proc.error && <ErrorBanner message={proc.error.message} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Eraser size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || proc.status === "processing"}
          onClick={() => proc.run(() => removeMetadata(file), file)}
        >
          {proc.status === "processing" ? "Cleaning…" : "Remove Metadata"}
        </Button>
      </div>
    </div>
  );
}
