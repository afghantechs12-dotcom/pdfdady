import { PdfExportService } from "@/src/application/editor/export/PdfExportService";
import type { EditorState } from "@/src/domain/editor/document";

/**
 * Client-side PDF export (Part 1 — "preserve document integrity" + the real
 * editing payoff). Renders the editor state to a PDF via {@link PdfExportService}
 * (which dynamic-imports pdf-lib, so it's code-split out of the main bundle). If
 * a source PDF's bytes are provided (the "Open PDF" flow), the export draws the
 * edits onto copies of the original pages — preserving the original content.
 */
export async function exportEditorPdf(state: EditorState, sourcePdfBytes?: Uint8Array): Promise<Uint8Array> {
  const svc = new PdfExportService();
  return svc.exportPdf(state, sourcePdfBytes ? { sourcePdfBytes } : undefined);
}

/** Triggers a browser download of the bytes as a named file. */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = "application/pdf"): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
