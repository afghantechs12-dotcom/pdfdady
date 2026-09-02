import type { Bounds, Point } from "@/src/domain/editor/geometry";
import { boundsContains, boundsIntersect } from "@/src/domain/editor/geometry";
import { pageObjects, worldBounds, type EditorPage } from "@/src/domain/editor/document";

/**
 * Pure hit-testing for the editor canvas. Both methods operate in PAGE space —
 * the caller maps a screen pointer via {@link screenToPage} first — and test
 * against each object's {@link worldBounds} (the axis-aligned box of its local
 * geometry passed through its transform).
 *
 * Paint order is bottom-first (see {@link pageObjects}); the topmost object is
 * the LAST in that order. {@link HitTestService.hitTestPoint} therefore iterates
 * in reverse and returns the first hit, so an overlap resolves to the visually-
 * front object. {@link HitTestService.hitTestMarquee} keeps paint order
 * (bottom-first) since every intersecting object is selected, not just one.
 *
 * No state is held — every method is a function of its arguments — so the
 * service is trivially testable and safe to share as a DI singleton.
 */
export class HitTestService {
  /**
   * Returns the id of the topmost (last in paint order) visible, unlocked
   * object whose world bounds contain `pagePoint`, or null when nothing is hit.
   * `tolerance` (default 0) expands each object's world bounds on every side
   * before the contains test, so thin objects stay grabbable. Set
   * `includeLocked`/`includeHidden` to override the default skip behavior.
   */
  hitTestPoint(
    page: EditorPage,
    pagePoint: Point,
    options?: { includeLocked?: boolean; includeHidden?: boolean; tolerance?: number },
  ): string | null {
    const includeLocked = options?.includeLocked ?? false;
    const includeHidden = options?.includeHidden ?? false;
    const tolerance = options?.tolerance ?? 0;
    const objs = pageObjects(page);
    // Topmost is last in paint order → iterate in reverse, return first hit.
    for (let i = objs.length - 1; i >= 0; i--) {
      const obj = objs[i];
      if (!includeHidden && !obj.visible) continue;
      if (!includeLocked && obj.locked) continue;
      const b = worldBounds(obj);
      const expanded: Bounds = {
        x: b.x - tolerance,
        y: b.y - tolerance,
        width: b.width + 2 * tolerance,
        height: b.height + 2 * tolerance,
      };
      if (boundsContains(expanded, pagePoint)) return obj.id;
    }
    return null;
  }

  /**
   * Returns the ids of every visible, unlocked object whose world bounds
   * intersect `marquee`, in paint order (bottom-first). Empty array when the
   * marquee hits nothing. Set `includeLocked`/`includeHidden` to override the
   * default skip behavior.
   */
  hitTestMarquee(
    page: EditorPage,
    marquee: Bounds,
    options?: { includeLocked?: boolean; includeHidden?: boolean },
  ): string[] {
    const includeLocked = options?.includeLocked ?? false;
    const includeHidden = options?.includeHidden ?? false;
    const out: string[] = [];
    for (const obj of pageObjects(page)) {
      if (!includeHidden && !obj.visible) continue;
      if (!includeLocked && obj.locked) continue;
      if (boundsIntersect(worldBounds(obj), marquee)) out.push(obj.id);
    }
    return out;
  }
}
