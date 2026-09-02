import type { EditorState } from "@/src/domain/editor/document";
import { Command, CompositeCommand } from "./types";

/**
 * Manages the undo/redo stacks for the editor.
 *
 * The history is stateless w.r.t. the document: it only owns the two command
 * stacks and the transaction buffer. Every mutating call takes the current
 * {@link EditorState} and returns the next one, so the document lives in the
 * caller (a React `useState`), not here. This keeps the history trivially
 * serializable and testable — there is no hidden document mirror to drift out
 * of sync.
 *
 * Coalescing: when `execute` is called with a command whose `coalesceKey`
 * matches the command on top of the undo stack, and that top command offers a
 * `merge`, the two are merged in place (the stack doesn't grow). This is how a
 * live drag that fires dozens of move events collapses into one undo entry.
 *
 * Transactions: `beginTransaction`/`commit` buffer commands into a single
 * {@link CompositeCommand} that pushes as one undo entry. `rollback` inverts the
 * buffered commands and discards them, for an aborted multi-step operation.
 */

export interface CommandHistoryOptions {
  /** Maximum undo entries kept; oldest are dropped beyond this. */
  maxStackDepth?: number;
  /** Notified after any structural change (push/undo/redo/clear/commit). */
  onChange?: () => void;
}

interface PendingTransaction {
  label: string;
  commands: Command[];
}

export class CommandHistory {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  private readonly maxStackDepth: number;
  private readonly onChange?: () => void;
  private pending: PendingTransaction | null = null;
  /**
   * A monotonic count of applied mutations. See {@link revision}.
   */
  private revisionCounter = 0;

  constructor(options: CommandHistoryOptions = {}) {
    this.maxStackDepth = options.maxStackDepth ?? 100;
    this.onChange = options.onChange;
  }

  /** True when at least one command can be undone. */
  get canUndo(): boolean {
    return (this.pending?.commands.length ?? 0) > 0 || this.undoStack.length > 0;
  }

  /** True when at least one command can be redone. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The number of undo entries currently stacked. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /**
   * A monotonically increasing count of mutations applied to the document.
   *
   * This exists because `undoDepth` CANNOT identify document state, and the app
   * bar's save indicator needs exactly that: "does what is on screen still match
   * the copy the user exported?" Depth is the length of a stack, and three
   * ordinary paths make the length repeat over different documents —
   *
   *   1. the depth cap: `pushUndo` shifts the oldest entry past `maxStackDepth`,
   *      so beyond the cap the depth is pinned and never moves again;
   *   2. coalescing: a live drag merges into the top entry without growing the
   *      stack, so a whole gesture leaves the depth unchanged;
   *   3. re-branching: undo then a different edit returns to the same depth with
   *      different content.
   *
   * In each case a depth-based watermark reports "exported and untouched since"
   * over a document with unexported edits — a false reassurance that costs the
   * user work. Comparing revisions instead is sound: equal revision really does
   * mean no mutation has been applied since.
   *
   * Deliberately NOT reset by {@link clear}, so a watermark captured against a
   * previous document can never coincide with a freshly loaded one's counter.
   */
  get revision(): number {
    return this.revisionCounter;
  }

  /** The label of the next command to undo (for the Edit ▸ Undo item). */
  get undoLabel(): string | null {
    const top = this.undoStack[this.undoStack.length - 1];
    return top?.label ?? null;
  }

  /** The label of the next command to redo. */
  get redoLabel(): string | null {
    const top = this.redoStack[this.redoStack.length - 1];
    return top?.label ?? null;
  }

  /**
   * The undo stack's labels oldest→newest (the "past" in a history panel). The
   * last entry is the most recent undoable action. Exposed for the Part 6
   * history panel; the commands themselves are not leaked (only their labels).
   */
  undoLabels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  /**
   * The redo stack's labels next-redo→latest (the "future" in a history panel).
   * The first entry is what `redo()` would apply next.
   */
  redoLabels(): string[] {
    return [...this.redoStack].reverse().map((c) => c.label);
  }

  /**
   * Navigates history so the undo stack ends up with `targetUndoDepth` entries,
   * undoing/redoing as many steps as needed. Used by the history panel to jump
   * to a clicked entry. Applies/inverts directly and notifies once (not per
   * step), so the facade re-renders once. No-op mid-transaction.
   */
  jumpTo(state: EditorState, targetUndoDepth: number): EditorState {
    if (this.pending) return state;
    let s = state;
    const clamped = Math.max(0, Math.min(targetUndoDepth, this.undoStack.length + this.redoStack.length));
    // A jump to the current depth is a no-op, so the revision must not move.
    const startDepth = this.undoStack.length;
    while (this.undoStack.length > clamped && this.undoStack.length > 0) {
      const cmd = this.undoStack.pop() as Command;
      s = cmd.invert(s);
      this.redoStack.push(cmd);
    }
    while (this.undoStack.length < clamped && this.redoStack.length > 0) {
      const cmd = this.redoStack.pop() as Command;
      s = cmd.apply(s);
      this.undoStack.push(cmd);
    }
    if (this.undoStack.length !== startDepth) this.revisionCounter += 1;
    this.notify();
    return s;
  }

  /**
   * Runs a command against `state` and records it for undo. Returns the state
   * after the command. While a transaction is open, the command is buffered
   * (applied but not yet pushed) instead of stacked. Redo is cleared on every
   * non-coalesced push — a new edit branches history.
   */
  execute(command: Command, state: EditorState): EditorState {
    const next = command.apply(state);
    // The document changed, so the revision moves — including in the buffered and
    // coalesced paths below, where the undo stack does not grow.
    this.revisionCounter += 1;

    if (this.pending) {
      this.pending.commands.push(command);
      return next;
    }

    const top = this.undoStack[this.undoStack.length - 1];
    if (top && command.coalesceKey && command.coalesceKey === top.coalesceKey && top.merge) {
      const merged = top.merge(command);
      if (merged) {
        this.undoStack[this.undoStack.length - 1] = merged;
        this.notify();
        return next;
      }
    }

    this.pushUndo(command);
    this.redoStack.length = 0; // a new edit branches history
    this.notify();
    return next;
  }

  /** Undoes the most recent command (or the open transaction, if any). */
  undo(state: EditorState): EditorState {
    if (this.pending) {
      // Undoing mid-transaction rolls back the buffered commands and drops them.
      const commands = this.pending.commands;
      this.pending = null;
      let s = state;
      for (let i = commands.length - 1; i >= 0; i--) {
        s = commands[i].invert(s);
      }
      if (commands.length > 0) this.revisionCounter += 1;
      this.notify();
      return s;
    }
    const command = this.undoStack.pop();
    // Guarded: an undo with an empty stack changes nothing, and advancing the
    // revision here would decay the save indicator to "unsaved" on its own.
    if (!command) return state;
    const prev = command.invert(state);
    this.redoStack.push(command);
    this.revisionCounter += 1;
    this.notify();
    return prev;
  }

  /** Redoes the most recently undone command. */
  redo(state: EditorState): EditorState {
    if (this.pending) return state; // redo is disabled while a transaction is open
    const command = this.redoStack.pop();
    if (!command) return state;
    const next = command.apply(state);
    this.undoStack.push(command);
    this.revisionCounter += 1;
    this.notify();
    return next;
  }

  /** Opens a transaction; subsequent `execute` calls buffer until `commit`. */
  beginTransaction(label: string): void {
    if (this.pending) {
      throw new Error("Transaction already in progress; commit or rollback first.");
    }
    this.pending = { label, commands: [] };
  }

  /** Commits the open transaction as a single composite undo entry. */
  commit(state: EditorState): EditorState {
    if (!this.pending) throw new Error("No transaction in progress.");
    const { label, commands } = this.pending;
    this.pending = null;
    if (commands.length === 0) return state;
    if (commands.length === 1) {
      // A one-command transaction is just an ordinary push (no composite wrapper).
      this.pushUndo(commands[0]);
    } else {
      this.pushUndo(new CompositeCommand(label, commands));
    }
    this.redoStack.length = 0;
    this.notify();
    return state;
  }

  /** Aborts the open transaction: inverts its commands against `state` and drops. */
  rollback(state: EditorState): EditorState {
    if (!this.pending) return state;
    const commands = this.pending.commands;
    this.pending = null;
    let s = state;
    for (let i = commands.length - 1; i >= 0; i--) {
      s = commands[i].invert(s);
    }
    // The document is back where the transaction started, but the counter is
    // monotonic rather than a content hash, so it still moves. That errs toward
    // "unsaved" — the safe direction for a save indicator.
    if (commands.length > 0) this.revisionCounter += 1;
    this.notify();
    return s;
  }

  /** True when a transaction is buffering commands. */
  get inTransaction(): boolean {
    return this.pending !== null;
  }

  /**
   * Empties both stacks (e.g. on document load).
   *
   * `revisionCounter` is ADVANCED rather than reset. Resetting to 0 would let a
   * save watermark captured against a previous document match a freshly loaded
   * document's counter; merely leaving it unchanged has the same effect, because
   * `clear()` is called from `loadState`, which swaps the entire document — so the
   * old watermark would still compare equal and an unexported file would read as
   * "Exported". Advancing makes any pre-load watermark unmatchable, which is the
   * safe direction.
   */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
    this.revisionCounter += 1;
    this.notify();
  }

  private pushUndo(command: Command): void {
    this.undoStack.push(command);
    while (this.undoStack.length > this.maxStackDepth) {
      this.undoStack.shift();
    }
  }

  private notify(): void {
    this.onChange?.();
  }
}
