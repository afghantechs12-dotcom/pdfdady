/**
 * Text commit semantics — what leaving the inline text editor does to the
 * document.
 *
 * ## The defect this module encodes the fix for
 *
 * The text tool used to call `addText` on pointer-up, so an empty text object
 * entered the document BEFORE the user typed a character. Measured in Chrome
 * against the real object model (Layers rows + the history stack, not just the
 * DOM):
 *
 * ```
 * click with text tool   layers=1  name="Text"  history="Added object"   text=""
 * type "Escape keeps me?" layers=1                                       text=""
 * press Escape            layers=1  history="Added object"  undo="Undo Add object"
 * ```
 *
 * So Escape discarded the typed CONTENT but kept the OBJECT: the user silently
 * lost their text and gained an invisible, selectable, Layers-listed artifact.
 * The same eager creation also made one authoring gesture TWO history entries
 * ("Added object" then "Edited text"), so a single Ctrl+Z emptied the text and
 * left the object behind — the exact shape of Defect 2 in
 * `docs/shape-draw-root-cause.md`.
 *
 * ## The decision
 *
 * **Escape is a true cancel.** A text object created by the current gesture is a
 * DRAFT: it does not enter the document until it is committed with content. That
 * is the same contract the shape tools already ship — *"Escape cancels, off-page
 * creates nothing"* and the deferred-commit invariant *"a shape does not enter
 * the document until the gesture completes"*. Making Escape commit instead would
 * give the editor two different cancel semantics for two creation tools, and
 * would leave a user who opened a text box by accident no way to abandon it.
 *
 * An EXISTING object is never removed by leaving its editor. Cancel reverts to
 * the text it had on entry; committing an empty string is an explicit, labelled,
 * undoable edit of an object the user chose to keep. Deleting it would throw away
 * styling the user may want back, and Escape must not be able to destroy prose
 * that was already in the document.
 *
 * Both paths agree on the one rule that matters: **leaving the editor never
 * leaves behind something the user did not author.**
 */

/** Which kind of object the open editor is editing. */
export type TextEditSession =
  /** The text tool drew this box in the current gesture. Nothing is committed yet. */
  | "draft"
  /** A text object already in the document, opened by double-click or "Edit". */
  | "existing";

/** How the editor was left. */
export type TextExit = "commit" | "cancel";

/** What leaving the editor should do to the document. */
export type TextCommitOutcome =
  /** Add a new text object carrying this text. */
  | "create"
  /** Write this text onto the object being edited. */
  | "update"
  /** Leave the document exactly as it was — no object, no history entry. */
  | "discard";

export interface TextEditSessionState {
  readonly session: TextEditSession;
  /**
   * The text the object held when the editor opened. Always `""` for a draft,
   * which is what makes "the user typed nothing" and "the user cleared it"
   * distinguishable.
   */
  readonly initialText: string;
}

/**
 * True when `text` would put no glyph on the page.
 *
 * Whitespace counts as blank on purpose. A text object holding only spaces
 * renders nothing on the canvas and draws nothing in the export (the exporter
 * advances a space and moves on), so committing one produces exactly the
 * invisible-but-selectable artifact this module exists to prevent. It is only
 * ever used to decide whether a DRAFT is worth creating — an existing object is
 * never removed for being blank.
 */
export function isBlankText(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * The whole decision, in one place.
 *
 * `cancel` never writes anything, on either path: a draft was never in the
 * document, and an existing object keeps the text it had on entry.
 *
 * `commit` creates a draft only if it carries content, and updates an existing
 * object only if the text actually changed — a double-click followed by a click
 * away is not an edit and must not push a history entry.
 */
export function resolveTextExit(
  state: TextEditSessionState,
  exit: TextExit,
  text: string,
): TextCommitOutcome {
  if (exit === "cancel") return "discard";
  if (state.session === "draft") return isBlankText(text) ? "discard" : "create";
  return text === state.initialText ? "discard" : "update";
}
