import type { Point } from "@/src/domain/editor/geometry";

/**
 * Pure pan math for the hand tool + temporary spacebar hand mode (M6.8).
 *
 * A pan session records where the pointer went down (client px) and what the
 * viewport pan was at that instant; the live pan is start-pan plus the raw
 * client-pixel delta. Pan is a SCREEN-space translation, so it is zoom-
 * independent by construction (the same 100 px drag moves the page 100 px at
 * every zoom level). Panning never touches document objects or history — it
 * only produces a new viewport pan for React state.
 */

/** An active pan drag: the client-px anchor and the pan it started from. */
export interface PanSession {
  startClient: Point;
  startPan: Point;
}

/** Opens a pan session at the pointer-down position. */
export function beginPan(client: Point, pan: Point): PanSession {
  return { startClient: { ...client }, startPan: { ...pan } };
}

/** The viewport pan for the current pointer position (start + raw delta). */
export function panPosition(session: PanSession, client: Point): Point {
  return {
    x: session.startPan.x + (client.x - session.startClient.x),
    y: session.startPan.y + (client.y - session.startClient.y),
  };
}

/** Cancelling a pan restores exactly the pan the session started from. */
export function cancelPan(session: PanSession): Point {
  return { ...session.startPan };
}

/** Keyboard pan step in screen px (hand-tool arrow keys); Shift multiplies. */
export const KEYBOARD_PAN_STEP = 40;
export const KEYBOARD_PAN_STEP_BIG = 160;

/**
 * The pan delta for an arrow key while the hand tool is active (the keyboard
 * alternative to dragging), or null for non-arrow keys. Arrow-left moves the
 * viewport content right (pan increases), matching scrollbar conventions.
 */
export function keyboardPanDelta(key: string, big: boolean): Point | null {
  const step = big ? KEYBOARD_PAN_STEP_BIG : KEYBOARD_PAN_STEP;
  switch (key) {
    case "ArrowLeft": return { x: step, y: 0 };
    case "ArrowRight": return { x: -step, y: 0 };
    case "ArrowUp": return { x: 0, y: step };
    case "ArrowDown": return { x: 0, y: -step };
    default: return null;
  }
}
