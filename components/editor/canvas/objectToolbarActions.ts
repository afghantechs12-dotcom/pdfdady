/**
 * What the floating contextual toolbar offers for the current selection (P1
 * Phase G). PURE — no React, no DOM, no services.
 *
 * ## Why this is a separate resolver from `contextMenuLogic`
 *
 * The right-click menu is an EXHAUSTIVE surface: it lists cut/copy/paste,
 * four z-order operations, lock, hide, group, ungroup — everything that could
 * apply, because a menu the user deliberately opened is allowed to be long.
 * The floating toolbar is the opposite kind of surface. It appears unbidden,
 * next to the object, over the document, so every entry costs canvas the user
 * did not ask to give up. Four buttons is the budget.
 *
 * Reusing `resolveContextMenu` and slicing the first N items would have been
 * the smaller diff and the wrong model: the two surfaces disagree about
 * ORDERING (the toolbar leads with the object's most likely edit — "Replace"
 * for an image, "Fill" for a shape — which the menu does not even contain) and
 * about SOURCE TEXT, where the menu's mutating entries must all vanish.
 *
 * Every action id here maps to infrastructure that already exists:
 *  - `duplicate` / `delete`  → `EditorActionHandlers` (history-backed commands)
 *  - `copyText`             → the clipboard, for read-only runs
 *  - `edit`                 → the canvas's existing inline text editor
 *  - `crop`                 → the existing crop tool/mode
 *  - `replace`              → the Properties panel's existing image replace
 *  - `fill`/`stroke`/`color`/`width`/`opacity` → focus the matching Inspector
 *    control, rather than reimplementing a colour picker in a floating bar
 *  - `highlight` / `comment` → the existing highlight + annotation tools
 *  - `more`                 → opens the full context menu at the object
 *
 * Nothing here invents a capability. A P0 invariant is that read-only imported
 * PDF text may not be moved, resized, restyled or "converted" — so its toolbar
 * is Copy / Highlight / Comment / More, and `mutates` is false for all of them.
 */

import type { EditorObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { resolveSelectionAffordance } from "@/components/editor/canvas/selectionAffordances";

/** Every action the floating toolbar can offer. */
export type ObjectToolbarActionId =
  | "edit"
  | "duplicate"
  | "delete"
  | "replace"
  | "crop"
  | "fill"
  | "stroke"
  | "color"
  | "width"
  | "opacity"
  | "copyText"
  | "highlight"
  | "comment"
  | "more";

export interface ObjectToolbarAction {
  id: ObjectToolbarActionId;
  /** Visible label; also the accessible name when no `ariaLabel` is given. */
  label: string;
  /** Icon identifier resolved by the component's icon map. */
  icon: string;
  /** Disabled actions still render, so the affordance stays discoverable. */
  enabled: boolean;
  /** Why it is disabled (tooltip). Undefined when enabled. */
  reason?: string;
  /**
   * True when the action changes document content. Asserted by tests for the
   * source-text case: a read-only run must offer NO mutating action.
   */
  mutates: boolean;
  /** Destructive styling (Delete). */
  danger?: boolean;
}

/** The selection facts the resolver is allowed to use. */
export interface ObjectToolbarContext {
  /** The resolved selection (ids already mapped to objects, missing ids dropped). */
  objects: readonly EditorObject[];
  /**
   * Whether a crop is currently possible for a single image selection. Supplied
   * by the caller from the canonical `resolveCropEligibility`, so this module
   * does not become a second crop-eligibility authority.
   */
  cropAvailable?: boolean;
  /** Why crop is unavailable, when it is not. */
  cropReason?: string;
}

const act = (
  id: ObjectToolbarActionId,
  label: string,
  icon: string,
  mutates: boolean,
  extra: Partial<ObjectToolbarAction> = {},
): ObjectToolbarAction => ({ id, label, icon, enabled: true, mutates, ...extra });

const MORE = act("more", "More", "more", false);
const DUPLICATE = act("duplicate", "Duplicate", "duplicate", true);
const DELETE = act("delete", "Delete", "delete", true, { danger: true });

/**
 * Resolves the floating toolbar for the current selection, or `null` when no
 * toolbar should appear at all (empty selection).
 *
 * Locking is honoured the same way the context menu honours it: a locked object
 * keeps non-mutating entries and disables the mutating ones with a reason,
 * rather than presenting buttons that silently do nothing.
 */
export function resolveObjectToolbar(ctx: ObjectToolbarContext): ObjectToolbarAction[] | null {
  const { objects } = ctx;
  if (objects.length === 0) return null;

  const affordance = resolveSelectionAffordance(objects);

  /*
   * READ-ONLY IMPORTED PDF TEXT (P0 invariant).
   *
   * No duplicate — "duplicate as editable text" is precisely the discredited
   * editable-copy defect. No edit, no geometry. What remains is what a PDF
   * viewer legitimately offers over selected source text.
   */
  if (affordance.kind === "source-text") {
    return [
      act("copyText", "Copy", "copy", false),
      act("highlight", "Highlight", "highlight", true),
      act("comment", "Comment", "comment", true),
      MORE,
    ];
  }

  const locked = objects.some((o) => o.locked);
  const lockGate = (a: ObjectToolbarAction): ObjectToolbarAction =>
    a.mutates && locked
      ? { ...a, enabled: false, reason: "Unlock this object to change it" }
      : a;

  // A multi-selection gets only what is unambiguous across mixed kinds.
  if (affordance.kind === "multi") {
    return [DUPLICATE, DELETE, MORE].map(lockGate);
  }

  const only = objects[0];

  if (isObjectKind(only, "text")) {
    return [act("edit", "Edit", "edit", true), DUPLICATE, DELETE, MORE].map(lockGate);
  }

  if (isObjectKind(only, "image")) {
    const crop = act("crop", "Crop", "crop", true, {
      enabled: ctx.cropAvailable !== false,
      ...(ctx.cropAvailable === false && ctx.cropReason ? { reason: ctx.cropReason } : {}),
    });
    return [act("replace", "Replace", "replace", true), crop, DUPLICATE, DELETE, MORE].map(lockGate);
  }

  if (isObjectKind(only, "shape")) {
    return [
      act("fill", "Fill", "fill", true),
      act("stroke", "Stroke", "stroke", true),
      DUPLICATE,
      DELETE,
      MORE,
    ].map(lockGate);
  }

  if (isObjectKind(only, "drawing")) {
    return [
      act("color", "Color", "color", true),
      act("width", "Width", "width", true),
      DUPLICATE,
      DELETE,
      MORE,
    ].map(lockGate);
  }

  if (isObjectKind(only, "annotation")) {
    return [
      act("edit", "Edit", "edit", true),
      act("color", "Color", "color", true),
      DELETE,
      MORE,
    ].map(lockGate);
  }

  if (isObjectKind(only, "highlight")) {
    return [
      act("color", "Color", "color", true),
      act("opacity", "Opacity", "opacity", true),
      DELETE,
      MORE,
    ].map(lockGate);
  }

  // Signatures and any plugin-defined kind: the operations that are safe for
  // anything with bounds. Deliberately not "Edit" — there is no signature
  // editor, and offering one would be a dead affordance.
  return [DUPLICATE, DELETE, MORE].map(lockGate);
}

/** The toolbar's own size, used for placement math. Kept with the resolver so
 * the placement tests and the component agree on one estimate. */
export const OBJECT_TOOLBAR_SIZE = { height: 40, minWidth: 120 } as const;

/** Vertical clearance between the object's box and the toolbar. */
export const OBJECT_TOOLBAR_GAP = 10;

export interface ToolbarPlacement {
  left: number;
  top: number;
  /** Which side of the object the bar ended up on (for the caller's styling). */
  side: "above" | "below";
}

/**
 * Places the toolbar in CONTAINER coordinates: horizontally centred on the
 * selection, above it when there is room, otherwise below.
 *
 * Pure, because the interesting cases are all edges — an object at the top of
 * the page, an object at the very bottom, a selection wider than the container
 * — and each is a one-line test here versus a browser scenario otherwise.
 * Clamped so the bar is always fully inside the container, since a toolbar half
 * outside the canvas is unclickable.
 */
export function placeObjectToolbar(
  box: { x: number; y: number; width: number; height: number },
  container: { width: number; height: number },
  size: { width: number; height: number } = {
    width: OBJECT_TOOLBAR_SIZE.minWidth,
    height: OBJECT_TOOLBAR_SIZE.height,
  },
  margin = 8,
): ToolbarPlacement {
  const above = box.y - OBJECT_TOOLBAR_GAP - size.height;
  const below = box.y + box.height + OBJECT_TOOLBAR_GAP;

  // Prefer above (it does not cover the object's own content, and matches the
  // convention in Figma/Canva); fall back to below only when above would clip.
  const fitsAbove = above >= margin;
  const side: "above" | "below" = fitsAbove ? "above" : "below";
  let top = fitsAbove ? above : below;

  // If neither side fits (a selection taller than the container), keep the bar
  // on screen rather than pushing it out of reach.
  const maxTop = container.height - size.height - margin;
  top = Math.max(margin, Math.min(top, maxTop));

  const centred = box.x + box.width / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(centred, container.width - size.width - margin));

  return { left, top, side };
}
