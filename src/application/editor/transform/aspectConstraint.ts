import { isObjectKind, type EditorObject } from "@/src/domain/editor/objects";

/**
 * Which resize drags keep the object's proportions.
 *
 * WHY THIS EXISTS. `resizeObject` scaled x and y independently for every object,
 * so dragging a corner of a photo stretched it: measured on a 1.7:1 inserted
 * image, a corner drag produced a 1.0:1 box with the picture squashed inside it.
 * For a shape or a text frame free scaling is the whole point — a rectangle is
 * meant to become a different rectangle. For PIXEL content it is almost never the
 * intent, and it is the one distortion the user cannot undo by eye afterwards
 * (there is no "restore original proportions" anywhere in the editor).
 *
 * So the rule is per-kind, not global:
 *
 *  - `image` and `signature` — locked by default. A signature stretched to 1.4×
 *    horizontally is a forged-looking signature, which is worse than a wrong size.
 *  - everything else — free, exactly as before.
 *
 * SHIFT INVERTS IT, always. Holding Shift while dragging frees an image (a
 * deliberate stretch is still one modifier away, so nothing that used to be
 * possible became impossible) and constrains a shape or text frame (the
 * convention every drawing tool shares). The Inspector's W/H fields stay
 * unconstrained either way — a typed number is unambiguous about intent.
 *
 * Kept out of `TransformService` on purpose: the geometry there should have no
 * opinion about object kinds, and the canvas gesture should not re-derive the
 * rule inline where it cannot be tested.
 */

/** Object kinds whose proportions are defended unless the user says otherwise. */
export function hasFixedAspectByDefault(obj: EditorObject | null | undefined): boolean {
  if (!obj) return false;
  return isObjectKind(obj, "image") || isObjectKind(obj, "signature");
}

/**
 * Whether this resize drag should keep the object's current aspect ratio.
 *
 * `obj` is the single object being resized, or null for a multi-selection —
 * which is always free: `resizeSelection` scales a heterogeneous group about the
 * selection box, and there is no ratio that is "the" ratio of a group.
 */
export function shouldLockAspect(
  obj: EditorObject | null | undefined,
  shiftKey: boolean,
): boolean {
  if (!obj) return false;
  return hasFixedAspectByDefault(obj) !== shiftKey;
}
