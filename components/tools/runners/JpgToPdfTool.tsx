"use client";

import { FileOutput } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { jpgToPdf } from "@/lib/pdf/jpgToPdf";

interface JpgToPdfToolProps {
  accept?: string[];
  title?: string;
  acceptHint?: string;
}

export function JpgToPdfTool({
  accept = ["image/jpeg", "image/png"],
  title = "Drop your images here",
  acceptHint = "JPG or PNG · One image per page · Max 50MB each",
}: JpgToPdfToolProps) {
  const upload = useFileUpload({ accept, multiple: true });
  const proc = usePdfProcessor({ fileCount: upload.files.length });

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
        accept={accept}
        multiple
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={upload.removeFile}
        title={title}
        subtitle="or click to browse"
        acceptHint={acceptHint}
      />

      {proc.status === "error" && proc.error && <ErrorBanner message={proc.error.message} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<FileOutput size={18} />}
          loading={proc.status === "processing"}
          disabled={upload.files.length < 1 || proc.status === "processing"}
          onClick={() => proc.run(() => jpgToPdf(upload.files), upload.files)}
        >
          {proc.status === "processing" ? "Converting…" : "Convert to PDF"}
        </Button>
      </div>
    </div>
  );
}
