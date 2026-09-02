"use client";

import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { releasePdfDoc, retainPdfDoc } from "@/lib/pdf/render";
import { PdfProcessingError } from "@/lib/pdf/types";

export type PdfDocStatus = "idle" | "loading" | "ready" | "error";

interface UsePdfDocumentResult {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  status: PdfDocStatus;
  error: string | null;
}

/**
 * Loads a File into a PDF.js document for previewing. Mirrors usePdfProcessor's
 * shape (status/error) so tool components stay consistent. The proxy is a shared
 * ref-counted instance (see lib/pdf/render.ts): this hook retains it while
 * mounted and releases it on unmount/file-change, and the cache destroys the
 * worker-side document once the last consumer is gone.
 */
export function usePdfDocument(file: File | null | undefined): UsePdfDocumentResult {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<PdfDocStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!file) {
      setDoc(null);
      setStatus("idle");
      setError(null);
      return;
    }

    setStatus("loading");
    setError(null);
    retainPdfDoc(file)
      .then((loaded) => {
        if (!active) return;
        setDoc(loaded);
        setStatus("ready");
      })
      .catch((err) => {
        if (!active) return;
        setDoc(null);
        setStatus("error");
        setError(
          err instanceof PdfProcessingError
            ? err.message
            : "We couldn't open this PDF for preview.",
        );
      });

    return () => {
      active = false;
      releasePdfDoc(file);
    };
  }, [file]);

  return { doc, pageCount: doc?.numPages ?? 0, status, error };
}
