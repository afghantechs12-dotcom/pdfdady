"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Save } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import { usePdfDocument } from "@/hooks/usePdfDocument";
import { editPdf } from "@/lib/pdf/edit";
import { LARGE_DOC_THRESHOLD, type PageEntry } from "./EditPageGrid";

// The drag-reorder grid pulls in framer-motion; load it only once a document
// is actually open so the library stays out of the initial route bundle.
const EditPageGrid = dynamic(
  () => import("./EditPageGrid").then((m) => m.EditPageGrid),
  {
    ssr: false,
    loading: () => (
      <p className="mt-4 text-center text-sm text-navy-soft">
        Loading page editor…
      </p>
    ),
  },
);

export function EditTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];
  const { doc, pageCount, status: docStatus, error: docError } =
    usePdfDocument(file);
  const [pages, setPages] = useState<PageEntry[]>([]);

  // Rebuild the page list whenever a new document finishes loading.
  useEffect(() => {
    if (docStatus === "ready" && pageCount > 0) {
      setPages(
        Array.from({ length: pageCount }, (_, i) => ({
          id: `p-${i}`,
          originalIndex: i,
          rotation: 0,
        })),
      );
    } else {
      setPages([]);
    }
  }, [docStatus, pageCount]);

  if (proc.status === "done" && proc.result) {
    return (
      <ResultActions
        result={proc.result}
        onReset={() => {
          proc.reset();
          upload.reset();
          setPages([]);
        }}
      />
    );
  }

  const rotate = (id: string) =>
    setPages((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, rotation: (p.rotation + 90) % 360 } : p,
      ),
    );

  const remove = (id: string) =>
    setPages((prev) => prev.filter((p) => p.id !== id));

  const move = (index: number, dir: -1 | 1) =>
    setPages((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const handleApply = () =>
    proc.run(
      () =>
        editPdf(
          file,
          pages.map(({ originalIndex, rotation }) => ({
            originalIndex,
            rotation,
          })),
        ),
      file,
    );

  return (
    <div>
      <UploadDropzone
        accept={["application/pdf"]}
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={(i) => {
          upload.removeFile(i);
          setPages([]);
        }}
        title="Drop your PDF here"
        subtitle="or click to browse"
        acceptHint="Select one PDF · Max 50MB"
      />

      {file && docStatus === "loading" && (
        <p className="mt-6 text-center text-sm text-navy-soft">
          Loading page previews…
        </p>
      )}

      {file && docStatus === "error" && docError && (
        <ErrorBanner message={docError} />
      )}

      {file && doc && pages.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium text-navy">
            Rotate, delete or drag pages to reorder, then save. The preview
            updates live.
          </p>
          {pages.length > LARGE_DOC_THRESHOLD && (
            <p className="mt-1 rounded-lg bg-lavender/60 px-3 py-1.5 text-xs text-navy-soft">
              Large document ({pages.length} pages) — thumbnails render as you
              scroll to keep things fast.
            </p>
          )}
          <EditPageGrid
            doc={doc}
            pages={pages}
            onReorder={setPages}
            onMove={move}
            onRotate={rotate}
            onRemove={remove}
          />
        </div>
      )}

      {proc.status === "error" && proc.error && <ErrorBanner message={proc.error.message} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Save size={18} />}
          loading={proc.status === "processing"}
          disabled={!file || pages.length === 0 || proc.status === "processing"}
          onClick={handleApply}
        >
          {proc.status === "processing" ? "Saving…" : "Apply & Download"}
        </Button>
        {file && doc && pages.length === 0 && (
          <p className="mt-2 text-center text-xs text-navy-soft">
            All pages were removed. Add the file again to start over.
          </p>
        )}
      </div>
    </div>
  );
}
