import type { Bounds, Point } from "@/src/domain/editor/geometry";

/**
 * Pure formatting logic for the editor status bar (M6). Node-testable; the
 * StatusBar component is a thin render layer over these.
 */

/** Human labels for the built-in object kinds (plugin kinds fall back to capitalization). */
const KIND_LABELS: Record<string, string> = {
  text: "Text",
  image: "Image",
  shape: "Shape",
  highlight: "Highlight",
  drawing: "Drawing",
  annotation: "Note",
  signature: "Signature",
};

/** The display label for one object kind. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? (kind.length > 0 ? kind[0].toUpperCase() + kind.slice(1) : "Object");
}

/**
 * The selection summary shown in the status bar:
 *  - nothing selected → "No selection"
 *  - one object → its kind label (e.g. "Text")
 *  - several of one kind → "3 Text objects"
 *  - mixed kinds → "3 objects"
 */
export function summarizeSelection(kinds: string[]): string {
  if (kinds.length === 0) return "No selection";
  if (kinds.length === 1) return kindLabel(kinds[0]);
  const first = kinds[0];
  const allSame = kinds.every((k) => k === first);
  return allSame ? `${kinds.length} ${kindLabel(first)} objects` : `${kinds.length} objects`;
}

/** Formats pointer coordinates in whole page units, or an em dash outside the canvas. */
export function formatPageCoords(p: Point | null): string {
  if (!p) return "—";
  return `${Math.round(p.x)}, ${Math.round(p.y)}`;
}

/** Formats a zoom factor as a whole percentage ("150%"). */
export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * The canvas's live interaction state the status bar reflects (M6.14). The
 * canvas reports this upward only when a value CHANGES (crop draft resized,
 * anchor added) — never per pointer-move — so the status bar re-renders on
 * meaningful transitions only.
 */
export interface InteractionStatus {
  /** The live crop draft in natural px, or null when not cropping. */
  cropDraft: Bounds | null;
  /** Anchors placed in the in-progress pen path; 0 = not building. */
  pathAnchorCount: number;
}

/** The idle interaction state (no crop session, no path in progress). */
export const IDLE_INTERACTION: InteractionStatus = { cropDraft: null, pathAnchorCount: 0 };

/**
 * The interaction summary line, or null when there is nothing relevant to
 * show (the status bar hides the field entirely — no misleading text). Crop
 * wins over path: the two can't be active simultaneously (switching tools
 * cancels the other), so ordering is just belt-and-braces.
 */
export function interactionSummary(status: InteractionStatus): string | null {
  if (status.cropDraft) {
    const { width, height } = status.cropDraft;
    return `Crop: ${Math.round(width)} × ${Math.round(height)} px — Enter applies, Esc cancels`;
  }
  if (status.pathAnchorCount > 0) {
    const n = status.pathAnchorCount;
    return `Pen: ${n} anchor${n === 1 ? "" : "s"} — Enter finishes, Esc cancels`;
  }
  return null;
}

/**
 * Display names for the editor tools (status bar "current tool" readout) —
 * re-exported from the canonical toolbar layout so the status bar and the
 * toolbar can never disagree (M6.7).
 */
export { TOOL_LABELS } from "@/components/editor/toolbarLayout";
