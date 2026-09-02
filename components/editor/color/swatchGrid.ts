/**
 * Arrow-key navigation for a swatch grid, as pure index arithmetic.
 *
 * A grid of colour swatches is a single composite widget, not 36 tab stops: the
 * brief requires arrow-key navigation inside popovers, and a user tabbing 36
 * times to reach the hex field would reasonably conclude the control is broken.
 * So the grid is one tab stop with `tabIndex` roving over the active cell, and
 * this function decides where the arrows go.
 *
 * Rules chosen deliberately:
 *  - Left/Right move linearly through the whole grid and WRAP across rows, so
 *    holding Right walks every swatch in reading order. Wrapping stops at the
 *    ends (no jump from last to first) because a colour grid is a list of finite
 *    choices, and silently teleporting to the other end loses the user's place.
 *  - Up/Down move by a full row and are refused at the edges rather than
 *    clamping to the nearest cell, so a column walk stays in its column.
 *  - Home/End jump to the first/last swatch.
 *
 * Returns the next index, or the SAME index when the move is refused — the
 * caller can compare and skip `preventDefault` so an unhandled arrow at the grid
 * edge can still fall through to the browser.
 */
export type SwatchGridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function nextSwatchIndex(
  current: number,
  key: SwatchGridKey,
  count: number,
  columns: number,
): number {
  if (count <= 0 || columns <= 0) return current;
  const clamped = Math.max(0, Math.min(current, count - 1));
  switch (key) {
    case "ArrowLeft":
      return clamped > 0 ? clamped - 1 : clamped;
    case "ArrowRight":
      return clamped < count - 1 ? clamped + 1 : clamped;
    case "ArrowUp": {
      const up = clamped - columns;
      return up >= 0 ? up : clamped;
    }
    case "ArrowDown": {
      const down = clamped + columns;
      return down < count ? down : clamped;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}

/** Narrows a raw `KeyboardEvent.key` to the keys the grid handles. */
export function asSwatchGridKey(key: string): SwatchGridKey | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End":
      return key;
    default:
      return null;
  }
}
