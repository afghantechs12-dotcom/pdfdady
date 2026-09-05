import type { EditorObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { makeBounds, makeTranslate, type Point } from "@/src/domain/editor/geometry";
import { clampToPage, defaultShapeSize, isShapeDrag, shapeClickBounds, shapeDragBounds, type PageSize } from "./shapeCreation";

/** One geometry/style resolver used by BOTH the ephemeral preview and commit. */
export function resolveShapeDraft(template: EditorObject, from: Point, to: Point, page: PageSize, shift = false): EditorObject {
  const start = clampToPage(from, page);
  let end = clampToPage(to, page);
  const line = isObjectKind(template, "shape") && ["line", "connector"].includes(template.shape);
  if (shift && isShapeDrag(start, end)) {
    const dx = end.x - start.x, dy = end.y - start.y;
    if (line) {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
      const len = Math.hypot(dx, dy);
      const vx = Math.cos(angle) * len, vy = Math.sin(angle) * len;
      const fraction = Math.min(1, vx > 0 ? (page.width - start.x) / vx : vx < 0 ? -start.x / vx : 1,
        vy > 0 ? (page.height - start.y) / vy : vy < 0 ? -start.y / vy : 1);
      end = { x: start.x + vx * fraction, y: start.y + vy * fraction };
    } else {
      const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
      const size = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), sx > 0 ? page.width - start.x : start.x, sy > 0 ? page.height - start.y : start.y);
      end = { x: start.x + sx * size, y: start.y + sy * size };
    }
  }
  const drag = isShapeDrag(start, to);
  const b = drag ? shapeDragBounds(start, end, page) : shapeClickBounds(start, defaultShapeSize(page), page);
  const result = { ...template, localBounds: makeBounds(0, 0, b.width, b.height), transform: makeTranslate(b.x, b.y) };
  if (line && drag && isObjectKind(result, "shape")) {
    result.points = [{ x: start.x - b.x, y: start.y - b.y }, { x: end.x - b.x, y: end.y - b.y }];
  }
  return result;
}
