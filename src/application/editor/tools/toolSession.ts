import type { EditorTool } from "@/components/editor/editorTypes";

/**
 * How long a tool stays armed once chosen — the policy behind "one-shot vs
 * pinned", kept pure so it is one decision rather than eight scattered calls.
 *
 * THE PROBLEM THIS SOLVES. Every insertion in the editor ended with a literal
 * `onToolChange("select")`: place a rectangle and the Rectangle tool silently
 * disarmed itself. That is the right default (most insertions are one-off, and a
 * still-armed tool turns the next click into an unwanted object), but it was the
 * ONLY behaviour. A user placing eight callouts had to re-pick the tool eight
 * times, and nothing in the UI said the tool was about to disarm — so the
 * disarming read as the app losing the tool rather than as a rule.
 *
 * Three persistences, decided by what the tool DOES rather than by taste:
 *
 *  - `modal`      The tool IS the mode; it stays until the user leaves it.
 *                 Select, Hand, Crop. Crop matters here: crop exits by
 *                 applying or cancelling, which is a mode exit, NOT a completed
 *                 insertion — pinning must never keep the user inside crop.
 *  - `one-shot`   Creates one object per gesture and disarms after it, unless
 *                 pinned. Text, image, signature, note, every shape, highlight.
 *  - `continuous` Inherently repeated; disarming after one stroke would be
 *                 absurd. Pen, pencil/draw, eraser.
 */
export type ToolPersistence = "modal" | "one-shot" | "continuous";

export function toolPersistence(tool: EditorTool): ToolPersistence {
  switch (tool) {
    case "select":
    case "hand":
    case "crop":
      return "modal";
    case "draw":
    case "eraser":
      return "continuous";
    default:
      // Every insertion tool: text, image, signature, annotation, all shape
      // kinds, highlight, path. A `default` rather than a 17-case list so a new
      // shape kind added to `EditorTool` is one-shot automatically, which is the
      // safe default — a new tool that silently stayed armed would create
      // objects the user did not ask for.
      return "one-shot";
  }
}

/** Whether a tool can be pinned at all. Only one-shot tools have anything to pin. */
export function isPinnable(tool: EditorTool): boolean {
  return toolPersistence(tool) === "one-shot";
}

/**
 * The armed tool plus whether the user has deliberately pinned it.
 *
 * `pinned` is a property of the SESSION, not of the tool: pinning Rectangle then
 * switching to Ellipse must not silently arrive pre-pinned, because a pin the
 * user did not ask for is exactly the "tool stayed armed and made an object I
 * didn't want" failure in a new costume.
 */
export interface ToolSession {
  active: EditorTool;
  pinned: boolean;
}

export const INITIAL_TOOL_SESSION: ToolSession = { active: "select", pinned: false };

/**
 * Choose a tool. Re-choosing the tool already active TOGGLES its pin — a
 * discoverable gesture (click the armed tool again to make it stick) that costs
 * no extra affordance, alongside the explicit pin control in the toolbar.
 *
 * Switching to a different tool always starts unpinned, for the reason in
 * {@link ToolSession}.
 */
export function selectTool(session: ToolSession, tool: EditorTool): ToolSession {
  if (tool === session.active) {
    return isPinnable(tool) ? { active: tool, pinned: !session.pinned } : session;
  }
  return { active: tool, pinned: false };
}

/** Explicitly set the pin, for a dedicated pin control. A no-op on unpinnable tools. */
export function setPinned(session: ToolSession, pinned: boolean): ToolSession {
  if (!isPinnable(session.active)) return session;
  if (session.pinned === pinned) return session;
  return { ...session, pinned };
}

/**
 * The session after a one-shot tool finishes creating something.
 *
 * This is the single policy the canvas's insertion sites call instead of each
 * hard-coding `"select"`. A pinned tool stays armed; an unpinned one-shot tool
 * disarms to Select; a continuous or modal tool is untouched (it never reaches
 * here in normal flow, but returning the session unchanged means a stray call
 * cannot yank the user out of Draw mid-stroke).
 */
export function afterInsertion(session: ToolSession): ToolSession {
  if (toolPersistence(session.active) !== "one-shot") return session;
  if (session.pinned) return session;
  return { active: "select", pinned: false };
}

/**
 * How the armed tool describes itself — the text half of the active-tool
 * indicator.
 *
 * Active state must not be carried by colour alone, and "one-shot vs pinned" is
 * exactly the distinction a colour swap cannot express. So the state is spelled
 * out in words: it goes in the status readout, and in the tool button's
 * `aria-label` / tooltip, where it is available to a screen reader and to anyone
 * who cannot tell the two ring colours apart.
 */
export function toolStateLabel(session: ToolSession): string {
  switch (toolPersistence(session.active)) {
    case "modal":
      return "active";
    case "continuous":
      return "active — keeps drawing";
    case "one-shot":
      return session.pinned ? "pinned — stays after each use" : "one use, then Select";
  }
}

/** The tooltip/`aria-label` suffix explaining how to change the pin. */
export function pinHint(session: ToolSession): string | null {
  if (!isPinnable(session.active)) return null;
  return session.pinned
    ? "Click again to unpin"
    : "Click again to pin it for repeated use";
}
