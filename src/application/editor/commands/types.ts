import type { EditorState } from "@/src/domain/editor/document";

/**
 * The command pattern for the PDFDadi editor.
 *
 * A {@link Command} is a pure, serializable intent over {@link EditorState}:
 * `apply` produces the next state, `invert` produces the state that undoes it.
 * Both are pure `(state) => state` functions — they never mutate the state they
 * receive — so undo/redo is a stack of inverse applications and React can hold
 * editor state in a single `useState`. The history (see {@link CommandHistory})
 * owns the stacks and the coalescing/transaction rules; commands stay dumb.
 *
 * Most commands use a symmetric "before/after" shape (apply swaps to `after`,
 * invert swaps back to `before`), which makes `invert` a mirror of `apply` and
 * keeps round-trips exact across arbitrary undo/redo cycles.
 */

/** A single undoable editor operation. */
export interface Command {
  /** Stable type id (e.g. "object.transform"); used for grouping/debugging. */
  readonly type: string;
  /** Human-readable label for the Edit ▸ Undo menu item. */
  readonly label: string;
  /** Produces the state after this command runs. Must be pure. */
  apply(state: EditorState): EditorState;
  /** Produces the state that undoes this command. Must be pure. */
  invert(state: EditorState): EditorState;
  /**
   * When set, consecutive commands on top of the undo stack with the SAME
   * coalesce key are merged instead of pushed separately. Used for live drag:
   * dozens of micro-moves become a single undo entry.
   */
  readonly coalesceKey?: string;
  /**
   * Combines this command (already on the stack) with a follow-up command that
   * shares its coalesce key. Returns the merged replacement, or null to decline
   * (in which case the follow-up pushes normally). Default: decline.
   */
  merge?(next: Command): Command | null;
  /**
   * Gets the object IDs affected by this command for cache invalidation.
   * Returns an array of object IDs, or empty array if none.
   */
  getAffectedObjectIds?(): string[];
}

/**
 * A composite command groups several commands into one undoable unit (a
 * transaction). `apply` runs them in order; `invert` runs them in reverse, so
 * the net effect unwinds exactly. Used by batch operations like "group these
 * objects" (which may move + restyle several at once).
 */
export class CompositeCommand implements Command {
  readonly type = "composite";
  readonly coalesceKey?: string;

  constructor(
    readonly label: string,
    private readonly commands: Command[],
    coalesceKey?: string,
  ) {
    if (commands.length === 0) {
      throw new Error("CompositeCommand requires at least one sub-command.");
    }
    this.coalesceKey = coalesceKey;
  }

  apply(state: EditorState): EditorState {
    return this.commands.reduce((s, cmd) => cmd.apply(s), state);
  }

  invert(state: EditorState): EditorState {
    // Reverse order so the unwind mirrors the apply.
    return [...this.commands].reverse().reduce((s, cmd) => cmd.invert(s), state);
  }
}
