import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSaveStatus, statusHasPendingWork } from "./derivedStatus";
import { evaluateNavigation, shouldArmBeforeUnload } from "./navigationGuard";
import {
  INITIAL_PERSISTENCE_STATE,
  hasUnprotectedWork,
  isCurrentRevisionLocallyDurable,
  persistenceReducer,
  type PersistenceState,
} from "./persistenceMachine";
import type { PersistenceEvent } from "./events";

/**
 * T2 — DEFECT A. Characters typed into the document while the editor reported
 * "No changes yet".
 *
 * The cause was not a bug in any rule. Text is authored in a `<textarea>` and only
 * becomes a command when it is committed, so between the first keystroke and that
 * commit `CommandHistory.revision` has not moved — and every durability question in
 * the system is asked about revisions. The document really was, by the only measure
 * available, unchanged.
 *
 * The requirement was that typing be dirty WITHOUT a blur, a selection change, an
 * Enter, a tool switch, a debounce or a save. So the fact travels as its own event
 * and is held as its own field, deliberately not as a revision: a phantom revision
 * would be satisfiable by a write that does not contain the characters, which is
 * the false-safe direction. Held apart, it can only subtract safety.
 *
 * Two halves are tested here, and the second is the one that would have caught the
 * original defect. A perfect policy nobody calls is the defect. The reducer half
 * proves the rule; the wiring half proves the textarea reports on CHANGE — the
 * blur-driven version of this is exactly the bug.
 */

const DOC = "doc-1";
const SESSION = "session-a";
const scope = { documentId: DOC, documentSessionId: SESSION } as const;

const apply = (state: PersistenceState, ...events: PersistenceEvent[]) =>
  events.reduce(persistenceReducer, state);

function opened(remoteEnabled = false): PersistenceState {
  return apply(INITIAL_PERSISTENCE_STATE, {
    ...scope,
    type: "DOCUMENT_OPENED",
    revision: 0,
    remoteEnabled,
    online: true,
    at: 1_000,
  });
}

const typing = (state: PersistenceState, pending: boolean, at = 2_000) =>
  apply(state, { ...scope, type: "UNCOMMITTED_INPUT_CHANGED", pending, at });

/** An edit plus a verified local draft of it: the strongest guest-side claim. */
function editedAndSaved(): PersistenceState {
  const state = apply(opened(), { ...scope, type: "DOCUMENT_MUTATED", revision: 1, at: 1_500 });
  return apply(
    state,
    { ...scope, type: "LOCAL_WRITE_SCHEDULED", requestId: "l1", revision: 1, at: 1_600 },
    { ...scope, type: "LOCAL_WRITE_STARTED", requestId: "l1", revision: 1, at: 1_610 },
    { ...scope, type: "LOCAL_WRITE_SUCCEEDED", requestId: "l1", revision: 1, at: 1_700, draftId: "d1" },
  );
}

describe("T2 — the first character is a change", () => {
  it("is dirty on the first keystroke, with no commit of any kind", () => {
    const state = typing(opened(), true);
    expect(state.edit).toBe("dirty");
    const status = deriveSaveStatus(state);
    expect(status.kind).not.toBe("unchanged");
    expect(status.kind).toBe("unsaved");
    expect(statusHasPendingWork(status)).toBe(true);
  });

  it("advances no revision, so undo/redo and the write scheduler see nothing", () => {
    const before = opened();
    const after = typing(before, true);
    expect(after.currentRevision).toBe(before.currentRevision);
    expect(after.baselineRevision).toBe(before.baselineRevision);
    expect(after.localChannel).toEqual(before.localChannel);
    expect(after.remoteChannel).toEqual(before.remoteChannel);
  });

  it("vetoes a durability claim that a completed write would otherwise support", () => {
    const saved = editedAndSaved();
    // Precondition, or the assertion below proves nothing: the save really did land.
    expect(isCurrentRevisionLocallyDurable(saved)).toBe(true);
    expect(deriveSaveStatus(saved).tone).toBe("success");

    const withTyping = typing(saved, true);
    expect(isCurrentRevisionLocallyDurable(withTyping)).toBe(false);
    expect(withTyping.edit).toBe("dirty");
    expect(deriveSaveStatus(withTyping).tone).not.toBe("success");
  });

  it("protects navigation while the characters exist nowhere else", () => {
    const state = typing(opened(), true);
    expect(hasUnprotectedWork(state)).toBe(true);
    expect(shouldArmBeforeUnload(state)).toBe(true);
    expect(evaluateNavigation(state).decision).toBe("block");
  });

  it("restores the previous claim when the text is committed or abandoned", () => {
    const saved = editedAndSaved();
    const restored = typing(typing(saved, true), false);
    expect(restored.edit).toBe("clean");
    expect(deriveSaveStatus(restored).tone).toBe("success");
    expect(shouldArmBeforeUnload(restored)).toBe(false);
  });

  it("ignores a report from a document session that has been replaced", () => {
    const state = apply(opened(), {
      type: "UNCOMMITTED_INPUT_CHANGED",
      documentId: DOC,
      documentSessionId: "session-b",
      pending: true,
      at: 2_000,
    });
    expect(state.uncommittedInput).toBe(false);
    expect(state.edit).toBe("clean");
  });

  it("clears when a different document is opened", () => {
    const state = apply(typing(opened(), true), {
      type: "DOCUMENT_OPENED",
      documentId: "doc-2",
      documentSessionId: "session-b",
      revision: 0,
      remoteEnabled: false,
      online: true,
      at: 3_000,
    });
    expect(state.uncommittedInput).toBe(false);
    expect(deriveSaveStatus(state).kind).toBe("unchanged");
  });
});

/**
 * The wiring, read from source. Vitest runs in Node here — no DOM, no React
 * renderer — so this asserts the chain exists and reports on the right event,
 * which is precisely what the defect got wrong. The behaviour in a real browser is
 * verified by `scripts/editor-save-state-probe.mjs`.
 */
describe("T2 — the textarea actually reports it", () => {
  const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");
  const TEXT_EDITOR = read("components/editor/canvas/TextEditor.tsx");
  const CANVAS = read("components/editor/EditorCanvas.tsx");
  const WORKSPACE = read("components/editor/EditorWorkspace.tsx");

  it("derives the flag from the draft value, not from a commit event", () => {
    // The whole fix in one line of product code.
    expect(TEXT_EDITOR).toContain("const uncommitted = value !== obj.text;");
    // Reported from an effect keyed on that fact, so the first keystroke reports.
    expect(TEXT_EDITOR).toContain("reportUncommitted.current?.(uncommitted);");
    expect(TEXT_EDITOR).toContain("}, [uncommitted]);");
  });

  it("does not depend on blur, Enter, or a tool switch to report", () => {
    const onBlur = TEXT_EDITOR.slice(TEXT_EDITOR.indexOf("onBlur={"));
    expect(onBlur.slice(0, 60)).not.toContain("reportUncommitted");
    expect(TEXT_EDITOR).toContain("onChange={(e) => setValue(e.target.value)}");
  });

  it("clears the flag on whichever exit the editor takes", () => {
    // One cleanup rather than four call sites remembering: commit, cancel, tool
    // switch and unmount all destroy this editor.
    const effect = TEXT_EDITOR.slice(
      TEXT_EDITOR.indexOf("reportUncommitted.current?.(uncommitted);"),
      TEXT_EDITOR.indexOf("}, [uncommitted]);"),
    );
    expect(effect).toContain("return () => {");
    expect(effect).toContain("reportUncommitted.current?.(false);");
  });

  it("connects the textarea to the persistence coordinator, unbroken", () => {
    expect(TEXT_EDITOR).toContain("onUncommittedChange");
    expect(CANVAS).toContain("onUncommittedChange={onUncommittedInputChange}");
    expect(WORKSPACE).toContain("onUncommittedInputChange={persistence.noteUncommittedInput}");
  });
});
