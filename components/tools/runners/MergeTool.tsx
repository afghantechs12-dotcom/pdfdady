"use client";

import { Combine } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { mergePdfs } from "@/lib/pdf/merge";

/**
 * Merge PDF.
 *
 * There is no analytics code here any more, and that is the point. The funnel
 * (`tool_view → file_selected → tool_start → job_succeeded | job_failed →
 * download`) is emitted by `usePdfProcessor`, `ToolAnalyticsProvider` and
 * `ResultActions` — the three places every local tool already goes through — so
 * this runner reports the same funnel as the other ten without restating any of
 * it, and a twelfth local tool is instrumented the moment it calls the hook.
 *
 * What used to live here: a `TOOL_SLUG` constant, a run counter ref, two status
 * effects and five `trackOnce` keys. It worked, and it was fifty lines that every
 * new tool would have had to copy correctly.
 */
export function MergeTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: true });
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
        accept={["application/pdf"]}
        multiple
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={upload.removeFile}
        title="Drop your PDFs here"
        subtitle="or click to browse"
        acceptHint="Add 2 or more PDF files · Max 50MB each"
      />

      {proc.status === "error" && proc.error && <ErrorBanner message={proc.error.message} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Combine size={18} />}
          loading={proc.status === "processing"}
          disabled={upload.files.length < 2 || proc.status === "processing"}
          onClick={() => proc.run(() => mergePdfs(upload.files), upload.files)}
        >
          {proc.status === "processing" ? "Merging…" : "Merge PDFs"}
        </Button>
        {upload.files.length === 1 && (
          <p className="mt-2 text-center text-xs text-navy-soft">
            Add at least one more PDF to merge.
          </p>
        )}
      </div>
    </div>
  );
}
