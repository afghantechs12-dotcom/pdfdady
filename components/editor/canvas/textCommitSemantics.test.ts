import { describe, expect, it } from "vitest";
import {
  isBlankText,
  resolveTextExit,
  type TextEditSessionState,
} from "@/components/editor/canvas/textCommitSemantics";

/**
 * The regression suite for text commit semantics.
 *
 * Every case here traces to a Chrome measurement of the OLD behaviour against the
 * real object model (Layers rows + the history stack), not to a preference. The
 * measurement that produced this module:
 *
 *   click with the text tool  -> layers=1, history "Added object", text=""
 *   type "Escape keeps me?"   -> layers=1, editorValue="Escape keeps me?", text=""
 *   press Escape              -> layers=1, history "Added object", text=""
 *
 * i.e. the typed content was discarded and the empty OBJECT survived. The fix
 * makes a tool-created text box a draft, so Escape leaves the document untouched
 * — the same contract the shape tools already ship.
 */

const draft: TextEditSessionState = { session: "draft", initialText: "" };
const existing: TextEditSessionState = { session: "existing", initialText: "Hello" };

describe("isBlankText", () => {
  it("treats the empty string as blank", () => {
    expect(isBlankText("")).toBe(true);
  });

  it("treats whitespace-only as blank — it puts no glyph on the page", () => {
    // A spaces-only object renders nothing on canvas and draws nothing in the
    // export, so committing one recreates the invisible-artifact defect.
    expect(isBlankText(" ")).toBe(true);
    expect(isBlankText("   ")).toBe(true);
    expect(isBlankText("\n")).toBe(true);
    expect(isBlankText("\t \n ")).toBe(true);
  });

  it("does not treat content as blank, including content with surrounding space", () => {
    expect(isBlankText("a")).toBe(false);
    expect(isBlankText("  padded  ")).toBe(false);
    expect(isBlankText("Escape keeps me?")).toBe(false);
  });
});

describe("resolveTextExit — the draft path (the measured defect)", () => {
  it("DISCARDS a cancelled draft, however much was typed", () => {
    // This is the defect. The old code kept the object and dropped the text.
    expect(resolveTextExit(draft, "cancel", "Escape keeps me?")).toBe("discard");
  });

  it("discards a cancelled draft that was never typed into", () => {
    expect(resolveTextExit(draft, "cancel", "")).toBe("discard");
  });

  it("CREATES the object when a draft is committed with content", () => {
    expect(resolveTextExit(draft, "commit", "Blur keeps me")).toBe("create");
  });

  it("discards a committed draft that is still empty", () => {
    // Clicking the text tool and then clicking away must not litter the document
    // with an invisible object the user never authored.
    expect(resolveTextExit(draft, "commit", "")).toBe("discard");
  });

  it("discards a committed draft that holds only whitespace", () => {
    expect(resolveTextExit(draft, "commit", "   ")).toBe("discard");
  });

  it("creates from a draft whose content is padded with whitespace", () => {
    expect(resolveTextExit(draft, "commit", "  hi  ")).toBe("create");
  });
});

describe("resolveTextExit — the existing path", () => {
  it("never writes on cancel: the object keeps the text it had on entry", () => {
    expect(resolveTextExit(existing, "cancel", "destroyed")).toBe("discard");
  });

  it("updates when the text actually changed", () => {
    expect(resolveTextExit(existing, "commit", "Hello world")).toBe("update");
  });

  it("does NOT delete an existing object for being cleared — that is an edit", () => {
    // Escape must never be able to destroy prose already in the document, and a
    // deliberate clear is a labelled, undoable edit that keeps the styling.
    expect(resolveTextExit(existing, "commit", "")).toBe("update");
    expect(resolveTextExit(existing, "commit", "   ")).toBe("update");
  });

  it("writes nothing when the text is unchanged", () => {
    // Double-click then click away is not an edit and must not push history.
    expect(resolveTextExit(existing, "commit", "Hello")).toBe("discard");
  });

  it("treats an existing object that was already empty the same way", () => {
    const emptied: TextEditSessionState = { session: "existing", initialText: "" };
    expect(resolveTextExit(emptied, "commit", "")).toBe("discard");
    expect(resolveTextExit(emptied, "commit", "typed")).toBe("update");
    expect(resolveTextExit(emptied, "cancel", "typed")).toBe("discard");
  });
});

describe("the two paths are consistent", () => {
  it("cancel writes nothing on either path", () => {
    for (const state of [draft, existing]) {
      expect(resolveTextExit(state, "cancel", "anything")).toBe("discard");
    }
  });

  it("a no-change commit writes nothing on either path", () => {
    // Draft: nothing typed. Existing: nothing altered. Same outcome.
    expect(resolveTextExit(draft, "commit", draft.initialText)).toBe("discard");
    expect(resolveTextExit(existing, "commit", existing.initialText)).toBe("discard");
  });

  it("only a commit carrying new content ever touches the document", () => {
    const touching: Array<[TextEditSessionState, string]> = [
      [draft, "new"],
      [existing, "changed"],
    ];
    for (const [state, text] of touching) {
      expect(resolveTextExit(state, "commit", text)).not.toBe("discard");
    }
  });
});
