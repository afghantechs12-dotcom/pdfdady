import type { EditorPage, EditorState, SelectionState } from "@/src/domain/editor/document";
import {
  clonePage,
  insertPageAt,
  movePage,
  removePage,
  setPageRotation,
  setPageSize,
  type PageRotation,
} from "@/src/domain/editor/pageOperations";
import { generateId } from "@/src/domain/editor/ids";
import { Command } from "./types";

/**
 * Page-level commands (M6 page operations). Same contract as [[commands]]:
 * pure before/after swaps with everything needed for an exact invert captured
 * at CONSTRUCTION time (via the factories below where a state snapshot is
 * needed), so redo replays deterministically — a duplicated page gets the same
 * fresh ids on every redo because the clone is built once, in the factory.
 */

// ---------------------------------------------------------------------------
// Insert / remove / duplicate
// ---------------------------------------------------------------------------

/** Inserts a page at an index (clamped). Invert removes it again. */
export class InsertPageCommand implements Command {
  readonly type = "page.insert";
  constructor(
    readonly label: string,
    private readonly page: EditorPage,
    private readonly index: number,
  ) {}

  apply(state: EditorState): EditorState {
    return insertPageAt(state, this.page, this.index);
  }

  invert(state: EditorState): EditorState {
    // removePage also reactivates a neighbor if the user made the inserted
    // page active before undoing — the undo can never leave a stale active id.
    return removePage(state, this.page.id);
  }
}

/**
 * Removes a page. The removed page, its index, the prior active page id, and
 * the prior selection are captured (via {@link removePageCommand}) so invert
 * restores the exact pre-removal state — including a selection that pointed at
 * objects on the removed page.
 */
export class RemovePageCommand implements Command {
  readonly type = "page.remove";
  constructor(
    readonly label: string,
    private readonly page: EditorPage,
    private readonly index: number,
    private readonly beforeActivePageId: string,
    private readonly beforeSelection: SelectionState,
  ) {}

  apply(state: EditorState): EditorState {
    return removePage(state, this.page.id);
  }

  invert(state: EditorState): EditorState {
    const inserted = insertPageAt(state, this.page, this.index);
    return {
      ...inserted,
      activePageId: this.beforeActivePageId,
      selection: this.beforeSelection,
    };
  }
}

/**
 * Inserts a pre-built duplicate of a page immediately after its source. The
 * clone (with ALL its fresh page/layer/object ids) is generated once in
 * {@link duplicatePageCommand}, so apply is deterministic and redo reuses the
 * identical ids. Invert removes the clone.
 */
export class DuplicatePageCommand implements Command {
  readonly type = "page.duplicate";
  constructor(
    readonly label: string,
    private readonly newPage: EditorPage,
    private readonly index: number,
  ) {}

  apply(state: EditorState): EditorState {
    return insertPageAt(state, this.newPage, this.index);
  }

  invert(state: EditorState): EditorState {
    return removePage(state, this.newPage.id);
  }
}

// ---------------------------------------------------------------------------
// Move / rotate / resize
// ---------------------------------------------------------------------------

/** Reorders a page between two captured indices; invert moves it back. */
export class MovePageCommand implements Command {
  readonly type = "page.move";
  constructor(
    readonly label: string,
    private readonly pageId: string,
    private readonly fromIndex: number,
    private readonly toIndex: number,
  ) {}

  apply(state: EditorState): EditorState {
    return movePage(state, this.pageId, this.toIndex);
  }

  invert(state: EditorState): EditorState {
    return movePage(state, this.pageId, this.fromIndex);
  }
}

/** Sets a page's rotation; `before` is captured by the caller for invert. */
export class SetPageRotationCommand implements Command {
  readonly type = "page.setRotation";
  constructor(
    readonly label: string,
    private readonly pageId: string,
    private readonly before: PageRotation,
    private readonly after: PageRotation,
  ) {}

  apply(state: EditorState): EditorState {
    return setPageRotation(state, this.pageId, this.after);
  }

  invert(state: EditorState): EditorState {
    return setPageRotation(state, this.pageId, this.before);
  }
}

/** A page size pair (editor units/points). */
export interface PageSize {
  width: number;
  height: number;
}

/** Sets a page's size; `before` is captured by the caller for invert. */
export class SetPageSizeCommand implements Command {
  readonly type = "page.setSize";
  constructor(
    readonly label: string,
    private readonly pageId: string,
    private readonly before: PageSize,
    private readonly after: PageSize,
  ) {}

  apply(state: EditorState): EditorState {
    return setPageSize(state, this.pageId, this.after.width, this.after.height);
  }

  invert(state: EditorState): EditorState {
    return setPageSize(state, this.pageId, this.before.width, this.before.height);
  }
}

// ---------------------------------------------------------------------------
// Capture factories — snapshot the current state for exact inverts.
// ---------------------------------------------------------------------------

/**
 * Builds a {@link RemovePageCommand} with the page, its index, the active page
 * id, and the selection captured. Throws (matching {@link moveToLayerCommand}'s
 * convention) when the page is missing or is the last remaining page — callers
 * that want a silent no-op guard first (the facade does).
 */
export function removePageCommand(
  state: EditorState,
  pageId: string,
  label = "Delete page",
): RemovePageCommand {
  const index = state.document.pages.findIndex((p) => p.id === pageId);
  if (index < 0) {
    throw new Error(`Cannot remove page ${pageId}: not found.`);
  }
  if (state.document.pages.length <= 1) {
    throw new Error("Cannot remove the last remaining page.");
  }
  return new RemovePageCommand(
    label,
    state.document.pages[index],
    index,
    state.activePageId,
    state.selection,
  );
}

/**
 * Builds a {@link DuplicatePageCommand} for `pageId`: clones the page NOW with
 * fresh ids (see {@link clonePage}) and captures the insertion index (one after
 * the source). Returns the command + the new page id (mirrors
 * {@link duplicateLayerCommand}'s shape). Throws when the page is missing.
 */
export function duplicatePageCommand(
  state: EditorState,
  pageId: string,
  label = "Duplicate page",
): { command: DuplicatePageCommand; pageId: string } {
  const index = state.document.pages.findIndex((p) => p.id === pageId);
  if (index < 0) {
    throw new Error(`Cannot duplicate page ${pageId}: not found.`);
  }
  const newPage = clonePage(state.document.pages[index], generateId("page"), generateId);
  return { command: new DuplicatePageCommand(label, newPage, index + 1), pageId: newPage.id };
}

/**
 * Builds a {@link MovePageCommand} with the page's current index captured and
 * the target clamped to the valid range, so apply/invert are exact mirrors.
 * Throws when the page is missing.
 */
export function movePageCommand(
  state: EditorState,
  pageId: string,
  toIndex: number,
  label = "Move page",
): MovePageCommand {
  const pages = state.document.pages;
  const fromIndex = pages.findIndex((p) => p.id === pageId);
  if (fromIndex < 0) {
    throw new Error(`Cannot move page ${pageId}: not found.`);
  }
  const clamped = Math.max(0, Math.min(Math.trunc(toIndex), pages.length - 1));
  return new MovePageCommand(label, pageId, fromIndex, clamped);
}
