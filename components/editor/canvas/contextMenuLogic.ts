/**
 * Pure applicability logic for the editor context menu (M6.15). Node-testable;
 * the ContextMenu component renders exactly what this resolves — no gating
 * rules live in JSX.
 *
 * Policy:
 *  - `visible: false` items are NOT rendered (actions that make no sense in
 *    the current context at all, e.g. "Crop Image" without an image).
 *  - `enabled: false` items render disabled (discoverable but blocked, e.g.
 *    "Group" with one object selected).
 *  - Locked objects: mutating the SELECTION is blocked while any selected
 *    object is locked (cut/delete would destroy a locked object; z-order and
 *    duplicate stay available — they don't alter the locked object's content).
 *    Lock/Unlock itself and Copy always work on a selection.
 */

import type { EditorObject } from "@/src/domain/editor/objects";
import { resolveCropEligibility } from "@/src/application/editor/tools/cropEligibility";

/** Everything the resolver needs to know about the current editor moment. */
export interface ContextMenuContext {
  /** Number of selected objects. */
  selectionCount: number;
  /** Kinds of the selected objects (same order as the selection). */
  selectedKinds: string[];
  /** True when at least one selected object is locked. */
  anyLocked: boolean;
  /** True when at least one selected object is visible. */
  anyVisible: boolean;
  /** True when at least one selected object belongs to a group. */
  anyGrouped: boolean;
  /** Full selected objects allow canonical crop eligibility checks. */
  selectedObjects?: readonly EditorObject[];
}

export type ContextMenuActionId =
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "bringForward"
  | "sendBackward"
  | "bringToFront"
  | "sendToBack"
  | "lock"
  | "hide"
  | "group"
  | "ungroup"
  | "cropImage";

export interface ResolvedMenuItem {
  id: ContextMenuActionId;
  label: string;
  shortcut?: string;
  enabled: boolean;
  /** Starts a new visual section before this item. */
  sectionStart?: boolean;
}

/**
 * Resolves the context menu for the current selection. Items whose action is
 * meaningless in this context are omitted entirely; contextually blocked ones
 * are returned disabled.
 */
export function resolveContextMenu(ctx: ContextMenuContext): ResolvedMenuItem[] {
  const has = ctx.selectionCount > 0;
  const mutable = has && !ctx.anyLocked;
  const isOneImage = ctx.selectionCount === 1 && ctx.selectedKinds[0] === "image";
  const cropEligibility = ctx.selectedObjects
    ? resolveCropEligibility(ctx.selectedObjects)
    : { available: isOneImage && !ctx.anyLocked };

  const items: ResolvedMenuItem[] = [
    { id: "cut", label: "Cut", shortcut: "Ctrl+X", enabled: mutable },
    { id: "copy", label: "Copy", shortcut: "Ctrl+C", enabled: has },
    { id: "paste", label: "Paste", shortcut: "Ctrl+V", enabled: true },
    { id: "duplicate", label: "Duplicate", shortcut: "Ctrl+D", enabled: has },
    { id: "delete", label: "Delete", shortcut: "Del", enabled: mutable },
    { id: "bringForward", label: "Bring Forward", shortcut: "Ctrl+]", enabled: has, sectionStart: true },
    { id: "sendBackward", label: "Send Backward", shortcut: "Ctrl+[", enabled: has },
    { id: "bringToFront", label: "Bring to Front", shortcut: "Ctrl+Shift+]", enabled: has },
    { id: "sendToBack", label: "Send to Back", shortcut: "Ctrl+Shift+[", enabled: has },
    { id: "lock", label: ctx.anyLocked ? "Unlock" : "Lock", enabled: has, sectionStart: true },
    { id: "hide", label: has && !ctx.anyVisible ? "Show" : "Hide", enabled: has },
    { id: "group", label: "Group", shortcut: "Ctrl+G", enabled: ctx.selectionCount >= 2, sectionStart: true },
    { id: "ungroup", label: "Ungroup", shortcut: "Ctrl+Shift+G", enabled: ctx.anyGrouped },
  ];

  // Crop is only rendered when it could ever apply here: exactly one image.
  if (isOneImage) {
    items.push({
      id: "cropImage",
      label: "Crop Image",
      shortcut: "C",
      enabled: cropEligibility.available,
      sectionStart: true,
    });
  }

  return items;
}

/**
 * Clamps a menu's position so the whole panel stays inside the viewport
 * (M6.15 edge collision). Pure so it is unit-testable.
 */
export function clampMenuPosition(
  pos: { x: number; y: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
  margin = 4,
): { x: number; y: number } {
  const x = Math.max(margin, Math.min(pos.x, view.width - menu.width - margin));
  const y = Math.max(margin, Math.min(pos.y, view.height - menu.height - margin));
  return { x, y };
}
