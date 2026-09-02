import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";
import { PdfProcessingError } from "./types";

/**
 * PDF.js rendering layer. This is the read/rasterize side of the app and is the
 * mirror of loadDocument.ts (which is the pdf-lib write side). pdf-lib cannot
 * render a page to pixels, so every visual preview goes through here.
 *
 * pdfjs-dist is imported dynamically so it (and its worker) stay out of any
 * bundle that doesn't actually render a page — only the preview components pull
 * it in. The worker version is pinned to match the API version in package.json;
 * they must be identical or PDF.js refuses to start.
 */

// The module is loaded once and shared. Typed loosely because pdfjs-dist's
// namespace type isn't exported cleanly for `typeof import(...)`.
type PdfJsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function getPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Resolve the worker through the bundler so Next fingerprints it and it
      // survives `output: "standalone"`. Must match the API version exactly.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * Per-File cache of parsed documents. Keyed by File identity so re-rendering a
 * page (page switch, resize, rotation) never re-parses the same upload. The
 * ArrayBuffer is copied because PDF.js transfers/detaches the buffer it's given.
 *
 * Entries are ref-counted: consumers that hold a document across renders
 * (usePdfDocument) retain/release it, and when the last reference drops the
 * proxy is destroy()ed after a short grace period. GC alone is not enough —
 * the pdf.js WORKER keeps parsed pages and decoded resources alive until
 * destroy() is called, so without this every uploaded file leaked worker
 * memory until a full page reload.
 */
interface DocCacheEntry {
  promise: Promise<PDFDocumentProxy>;
  refs: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
}

const docCache = new Map<File, DocCacheEntry>();
const DESTROY_GRACE_MS = 4_000;

/**
 * Increment the reference count for a File's document. Pair every call with
 * releasePdfDoc — when the count returns to zero the worker-side document is
 * destroyed (after a grace period that absorbs StrictMode remounts and quick
 * page switches).
 */
export function retainPdfDoc(file: File): Promise<PDFDocumentProxy> {
  const promise = getPdfDoc(file);
  const entry = docCache.get(file);
  if (entry) {
    entry.refs += 1;
    if (entry.destroyTimer) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
  }
  return promise;
}

export function releasePdfDoc(file: File): void {
  const entry = docCache.get(file);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.destroyTimer) return;
  entry.destroyTimer = setTimeout(() => {
    const current = docCache.get(file);
    if (!current || current.refs > 0) return;
    docCache.delete(file);
    current.promise.then(
      // In pdfjs-dist 6.x destroy() lives on the loading task; it tears down
      // the worker-side document and all its decoded resources.
      (doc) => doc.loadingTask.destroy().catch(() => undefined),
      () => undefined,
    );
  }, DESTROY_GRACE_MS);
}

export async function getPdfDoc(file: File): Promise<PDFDocumentProxy> {
  const cached = docCache.get(file);
  if (cached) return cached.promise;

  const promise = (async () => {
    const pdfjs = await getPdfjs();

    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      throw new PdfProcessingError(
        "We couldn't read this file. Please try again.",
        "corrupt_document",
      );
    }

    try {
      // Clone the buffer: getDocument detaches the one it receives, which would
      // break the pdf-lib path if it reads the same File later.
      const data = bytes.slice(0);
      const task = pdfjs.getDocument({ data });
      return await task.promise;
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "";
      const message =
        err instanceof Error ? err.message.toLowerCase() : "";
      if (name === "PasswordException" || message.includes("password")) {
        throw new PdfProcessingError(
          `"${file.name}" is password-protected and can't be previewed. Please remove its password first.`,
          "password_required",
        );
      }
      throw new PdfProcessingError(
        `We couldn't render "${file.name}". It may be corrupted or not a valid PDF.`,
        "corrupt_document",
      );
    }
  })();

  // If parsing fails, drop the rejected promise so a retry can re-attempt.
  promise.catch(() => docCache.delete(file));
  docCache.set(file, { promise, refs: 0, destroyTimer: null });
  return promise;
}

/**
 * Renders a single page to a canvas at the requested CSS width, honoring the
 * page's own /Rotate plus any extra rotation the caller wants (e.g. the editor's
 * live rotation). Returns the RenderTask so the caller can cancel it on unmount
 * or rapid page switches — cancelling throws RenderingCancelledException, which
 * callers must swallow.
 *
 * `cssWidth` is the desired displayed width in CSS pixels; the canvas backing
 * store is scaled by devicePixelRatio for crisp output on HiDPI screens.
 */
export interface RenderPageResult {
  cancel: () => void;
  done: Promise<void>;
  cssWidth: number;
  cssHeight: number;
}

export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  extraRotation = 0,
): Promise<RenderPageResult> {
  const rotation = ((page.rotate + extraRotation) % 360 + 360) % 360;
  const unscaled = page.getViewport({ scale: 1, rotation });
  const scale = cssWidth / unscaled.width;
  const viewport = page.getViewport({ scale, rotation });

  const dpr =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const cssHeight = viewport.height;

  canvas.width = Math.ceil(viewport.width * dpr);
  canvas.height = Math.ceil(cssHeight * dpr);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(cssHeight)}px`;

  const task = page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });

  return {
    cancel: () => task.cancel(),
    done: task.promise,
    cssWidth: viewport.width,
    cssHeight,
  };
}

/** True when an error is PDF.js's cancellation signal (safe to ignore). */
export function isRenderCancelled(err: unknown): boolean {
  return (err as { name?: string })?.name === "RenderingCancelledException";
}
