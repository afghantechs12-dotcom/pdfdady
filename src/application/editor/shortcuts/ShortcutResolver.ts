/**
 * Centralized, pure keyboard-shortcut resolver for the PDFDadi editor (Part 8).
 *
 * The UI normalizes a DOM `KeyboardEvent` into a {@link KeyDescriptor} — folding
 * Cmd into `ctrl` (so the resolver treats Ctrl and Cmd identically) and passing
 * the `event.key` — then calls {@link resolveShortcut} with a {@link ShortcutContext}
 * to obtain the {@link EditorAction} to dispatch, or `null` when the combo is not
 * bound. The resolver is pure and DOM-free, so it runs unchanged in Node tests.
 *
 * Selection-required actions (copy/cut/duplicate/delete/nudge/z-order/group/
 * ungroup) return `null` when `hasSelection` is false so the UI no-ops instead of
 * firing a meaningless command. Undo/redo/selectAll/zoom/save/export/escape
 * resolve regardless of selection. While editing text, only escape/enter/tab
 * resolve so typing and in-field shortcuts (ctrl+z, ctrl+c, …) reach the input.
 */

/** Action ids produced by the resolver; the UI dispatches each to the matching facade op. */
export type EditorAction =
  | "undo" | "redo" | "copy" | "cut" | "paste" | "duplicate" | "delete"
  | "selectAll" | "escape" | "enter" | "tab"
  | "bringForward" | "sendBackward" | "bringToFront" | "sendToBack"
  | "group" | "ungroup"
  | "nudge" | "nudgeBig"
  | "zoomIn" | "zoomOut" | "zoomReset" | "zoom100" | "zoom200"
  | "pagePrev" | "pageNext" | "pageFirst" | "pageLast"
  | "save" | "export"
  | "find";

/** A normalized key descriptor. `ctrl` is true for Ctrl OR Cmd (fold at the call site). */
export interface KeyDescriptor {
  /** The key (e.g. "c", "z", "Delete", "ArrowLeft", " "); compared case-insensitively. */
  key: string;
  /** True if Ctrl OR Cmd (meta) was held — normalize at the call site. */
  ctrl: boolean;
  /** True if Shift was held. */
  shift: boolean;
  /** True if Alt/Option was held. */
  alt: boolean;
}

/** Context the resolver gates actions on. */
export interface ShortcutContext {
  /** True when focus is in an input/textarea/contenteditable; only escape/enter/tab resolve. */
  isEditingText: boolean;
  /** True when at least one object is selected (enables selection-required actions). */
  hasSelection: boolean;
}

/** Small nudge delta in page units for Arrow keys. */
export const DEFAULT_NUDGE_SMALL = 1;

/** Large nudge delta in page units for Shift+Arrow keys. */
export const DEFAULT_NUDGE_BIG = 10;

const ARROW_KEYS = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown"]);

/**
 * Resolves a normalized key descriptor + context to an action id, or `null`.
 *
 * Pure and DOM-free. The key is matched case-insensitively; `ctrl` already folds
 * Cmd (Ctrl===Cmd) at the call site.
 */
export function resolveShortcut(key: KeyDescriptor, ctx: ShortcutContext): EditorAction | null {
  const k = key.key.toLowerCase();

  // While editing text, only escape/enter/tab resolve so typing isn't hijacked.
  //
  // `find` is the deliberate exception: Ctrl+F must reach the editor even from
  // inside a text field, because the browser's own find bar is the wrong answer
  // for a canvas document (it searches the DOM, which holds only the visible
  // page's rendered glyphs) and because the user's hand is often already in the
  // search box when they press it again. Every other ctrl-combo stays suppressed.
  if (ctx.isEditingText) {
    if (k === "escape") return "escape";
    if (k === "enter") return "enter";
    if (k === "tab") return "tab";
    if (key.ctrl && k === "f" && !key.shift) return "find";
    return null;
  }

  // Ctrl-keyed actions (ctrl is true for Ctrl OR Cmd — normalized at call site).
  if (key.ctrl) {
    // Undo/redo: ctrl+z → undo; ctrl+shift+z or ctrl+y → redo.
    if (k === "z") return key.shift ? "redo" : "undo";
    if (k === "y" && !key.shift) return "redo";
    // Clipboard + duplicate (copy/cut/duplicate require a selection; paste does not).
    if (k === "c" && !key.shift) return ctx.hasSelection ? "copy" : null;
    if (k === "x" && !key.shift) return ctx.hasSelection ? "cut" : null;
    if (k === "v" && !key.shift) return "paste";
    if (k === "d" && !key.shift) return ctx.hasSelection ? "duplicate" : null;
    // Select all.
    if (k === "a" && !key.shift) return "selectAll";
    // Z-order (selection-required): ] / [ with shift toggling to-front / to-back.
    if (k === "]") return ctx.hasSelection ? (key.shift ? "bringToFront" : "bringForward") : null;
    if (k === "[") return ctx.hasSelection ? (key.shift ? "sendToBack" : "sendBackward") : null;
    // Group/ungroup (selection-required): ctrl+g / ctrl+shift+g.
    if (k === "g") return ctx.hasSelection ? (key.shift ? "ungroup" : "group") : null;
    // Zoom: ctrl+"=" or ctrl+"+" in, ctrl+"-" out, ctrl+0 reset (shift-agnostic).
    // The UI maps zoomReset to "fit page" (M6 zoom system); ctrl+1/ctrl+2 jump
    // to the fixed 100%/200% levels.
    if (k === "=" || k === "+") return "zoomIn";
    if (k === "-") return "zoomOut";
    if (k === "0") return "zoomReset";
    if (k === "1" && !key.shift) return "zoom100";
    if (k === "2" && !key.shift) return "zoom200";
    // Page navigation (M6): ctrl+Home/End jump to the first/last page.
    if (k === "home") return "pageFirst";
    if (k === "end") return "pageLast";
    // Save/export: ctrl+s save, ctrl+shift+s export.
    if (k === "s") return key.shift ? "export" : "save";
    // In-document find (Ctrl+F). Searches the OPEN document's text objects — not
    // workspace search, which finds other documents entirely.
    if (k === "f" && !key.shift) return "find";
    return null;
  }

  // Non-ctrl actions.
  if (k === "escape") return "escape";
  if (k === "delete" || k === "backspace") return ctx.hasSelection ? "delete" : null;
  if (ARROW_KEYS.has(k)) return ctx.hasSelection ? (key.shift ? "nudgeBig" : "nudge") : null;
  // Page navigation (M6): PageUp/PageDown step to the previous/next page.
  if (k === "pageup") return "pagePrev";
  if (k === "pagedown") return "pageNext";

  return null;
}
