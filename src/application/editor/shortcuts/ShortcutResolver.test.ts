import { describe, expect, it } from "vitest";
import {
  DEFAULT_NUDGE_BIG,
  DEFAULT_NUDGE_SMALL,
  resolveShortcut,
  type KeyDescriptor,
  type ShortcutContext,
} from "./ShortcutResolver";

/** Builds a KeyDescriptor with defaulted modifiers. */
function kd(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyDescriptor {
  return {
    key,
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
  };
}

const SEL: ShortcutContext = { isEditingText: false, hasSelection: true };
const NO_SEL: ShortcutContext = { isEditingText: false, hasSelection: false };
const EDITING: ShortcutContext = { isEditingText: true, hasSelection: true };

describe("resolveShortcut: undo/redo", () => {
  it("ctrl+z → undo", () => {
    expect(resolveShortcut(kd("z", { ctrl: true }), SEL)).toBe("undo");
  });

  it("ctrl+shift+z → redo", () => {
    expect(resolveShortcut(kd("z", { ctrl: true, shift: true }), SEL)).toBe("redo");
  });

  it("ctrl+y → redo", () => {
    expect(resolveShortcut(kd("y", { ctrl: true }), SEL)).toBe("redo");
  });
});

describe("resolveShortcut: clipboard + duplicate", () => {
  it("ctrl+c/x/v → copy/cut/paste", () => {
    expect(resolveShortcut(kd("c", { ctrl: true }), SEL)).toBe("copy");
    expect(resolveShortcut(kd("x", { ctrl: true }), SEL)).toBe("cut");
    expect(resolveShortcut(kd("v", { ctrl: true }), SEL)).toBe("paste");
  });

  it("ctrl+d → duplicate", () => {
    expect(resolveShortcut(kd("d", { ctrl: true }), SEL)).toBe("duplicate");
  });
});

describe("resolveShortcut: delete + selectAll + escape", () => {
  it("Delete and Backspace → delete", () => {
    expect(resolveShortcut(kd("Delete"), SEL)).toBe("delete");
    expect(resolveShortcut(kd("Backspace"), SEL)).toBe("delete");
  });

  it("ctrl+a → selectAll", () => {
    expect(resolveShortcut(kd("a", { ctrl: true }), SEL)).toBe("selectAll");
  });

  it("Escape → escape", () => {
    expect(resolveShortcut(kd("Escape"), SEL)).toBe("escape");
  });
});

describe("resolveShortcut: z-order", () => {
  it("ctrl+] / ctrl+[ → bringForward / sendBackward", () => {
    expect(resolveShortcut(kd("]", { ctrl: true }), SEL)).toBe("bringForward");
    expect(resolveShortcut(kd("[", { ctrl: true }), SEL)).toBe("sendBackward");
  });

  it("ctrl+shift+] / ctrl+shift+[ → bringToFront / sendToBack", () => {
    expect(resolveShortcut(kd("]", { ctrl: true, shift: true }), SEL)).toBe("bringToFront");
    expect(resolveShortcut(kd("[", { ctrl: true, shift: true }), SEL)).toBe("sendToBack");
  });
});

describe("resolveShortcut: group/ungroup", () => {
  it("ctrl+g → group; ctrl+shift+g → ungroup", () => {
    expect(resolveShortcut(kd("g", { ctrl: true }), SEL)).toBe("group");
    expect(resolveShortcut(kd("g", { ctrl: true, shift: true }), SEL)).toBe("ungroup");
  });
});

describe("resolveShortcut: nudge", () => {
  it("arrow keys → nudge; shift+arrows → nudgeBig", () => {
    expect(resolveShortcut(kd("ArrowLeft"), SEL)).toBe("nudge");
    expect(resolveShortcut(kd("ArrowRight"), SEL)).toBe("nudge");
    expect(resolveShortcut(kd("ArrowUp"), SEL)).toBe("nudge");
    expect(resolveShortcut(kd("ArrowDown"), SEL)).toBe("nudge");
    expect(resolveShortcut(kd("ArrowLeft", { shift: true }), SEL)).toBe("nudgeBig");
    expect(resolveShortcut(kd("ArrowDown", { shift: true }), SEL)).toBe("nudgeBig");
  });

  it("exports default nudge deltas", () => {
    expect(DEFAULT_NUDGE_SMALL).toBe(1);
    expect(DEFAULT_NUDGE_BIG).toBe(10);
  });
});

describe("resolveShortcut: zoom", () => {
  it("ctrl+= or ctrl++ → zoomIn", () => {
    expect(resolveShortcut(kd("=", { ctrl: true }), SEL)).toBe("zoomIn");
    expect(resolveShortcut(kd("+", { ctrl: true }), SEL)).toBe("zoomIn");
  });

  it("ctrl+- → zoomOut; ctrl+0 → zoomReset", () => {
    expect(resolveShortcut(kd("-", { ctrl: true }), SEL)).toBe("zoomOut");
    expect(resolveShortcut(kd("0", { ctrl: true }), SEL)).toBe("zoomReset");
  });
});

describe("resolveShortcut: save/export", () => {
  it("ctrl+s → save; ctrl+shift+s → export", () => {
    expect(resolveShortcut(kd("s", { ctrl: true }), SEL)).toBe("save");
    expect(resolveShortcut(kd("s", { ctrl: true, shift: true }), SEL)).toBe("export");
  });
});

describe("resolveShortcut: isEditingText suppression", () => {
  it("hijacks nothing but escape/enter/tab/find while editing text", () => {
    expect(resolveShortcut(kd("z", { ctrl: true }), EDITING)).toBeNull();
    expect(resolveShortcut(kd("c", { ctrl: true }), EDITING)).toBeNull();
    expect(resolveShortcut(kd("Delete"), EDITING)).toBeNull();
    expect(resolveShortcut(kd("ArrowLeft"), EDITING)).toBeNull();
    expect(resolveShortcut(kd("a", { ctrl: true }), EDITING)).toBeNull();
  });

  it("still resolves escape/enter/tab while editing text", () => {
    expect(resolveShortcut(kd("Escape"), EDITING)).toBe("escape");
    expect(resolveShortcut(kd("Enter"), EDITING)).toBe("enter");
    expect(resolveShortcut(kd("Tab"), EDITING)).toBe("tab");
  });

  /**
   * Ctrl+F is the ONE ctrl-combo that survives the editing-text gate. The user's
   * hand is usually already in the search field when they press it again, and the
   * browser's native find bar is the wrong fallback for a canvas document: it
   * searches the DOM, which contains only the currently-rendered page.
   */
  it("lets Ctrl+F through while editing text, but nothing else ctrl-keyed", () => {
    expect(resolveShortcut(kd("f", { ctrl: true }), EDITING)).toBe("find");
    // Shift+Ctrl+F is not find, and must not leak through the gate either.
    expect(resolveShortcut(kd("f", { ctrl: true, shift: true }), EDITING)).toBeNull();
    // A bare "f" while typing is just the letter f.
    expect(resolveShortcut(kd("f"), EDITING)).toBeNull();
  });
});

describe("resolveShortcut: in-document find", () => {
  it("ctrl+f → find, with or without a selection", () => {
    expect(resolveShortcut(kd("f", { ctrl: true }), SEL)).toBe("find");
    expect(resolveShortcut(kd("f", { ctrl: true }), NO_SEL)).toBe("find");
  });

  it("does not claim a bare f (that is a tool letter's business)", () => {
    expect(resolveShortcut(kd("f"), SEL)).not.toBe("find");
  });

  it("does not claim ctrl+shift+f", () => {
    expect(resolveShortcut(kd("f", { ctrl: true, shift: true }), SEL)).toBeNull();
  });
});

describe("resolveShortcut: selection gating", () => {
  it("returns null for selection-required actions when !hasSelection", () => {
    expect(resolveShortcut(kd("c", { ctrl: true }), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("x", { ctrl: true }), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("d", { ctrl: true }), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("Delete"), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("ArrowLeft"), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("]", { ctrl: true }), NO_SEL)).toBeNull();
    expect(resolveShortcut(kd("g", { ctrl: true }), NO_SEL)).toBeNull();
  });

  it("still resolves selection-independent actions when !hasSelection", () => {
    expect(resolveShortcut(kd("z", { ctrl: true }), NO_SEL)).toBe("undo");
    expect(resolveShortcut(kd("y", { ctrl: true }), NO_SEL)).toBe("redo");
    expect(resolveShortcut(kd("a", { ctrl: true }), NO_SEL)).toBe("selectAll");
    expect(resolveShortcut(kd("0", { ctrl: true }), NO_SEL)).toBe("zoomReset");
    expect(resolveShortcut(kd("s", { ctrl: true }), NO_SEL)).toBe("save");
    expect(resolveShortcut(kd("Escape"), NO_SEL)).toBe("escape");
  });

  it("paste works without a selection", () => {
    expect(resolveShortcut(kd("v", { ctrl: true }), NO_SEL)).toBe("paste");
  });
});

describe("resolveShortcut: zoom levels (M6)", () => {
  it("ctrl+1 → zoom100; ctrl+2 → zoom200", () => {
    expect(resolveShortcut(kd("1", { ctrl: true }), SEL)).toBe("zoom100");
    expect(resolveShortcut(kd("2", { ctrl: true }), SEL)).toBe("zoom200");
    expect(resolveShortcut(kd("1", { ctrl: true }), NO_SEL)).toBe("zoom100");
  });

  it("ctrl+shift+1/2 stay unbound", () => {
    expect(resolveShortcut(kd("1", { ctrl: true, shift: true }), SEL)).toBeNull();
    expect(resolveShortcut(kd("2", { ctrl: true, shift: true }), SEL)).toBeNull();
  });
});

describe("resolveShortcut: page navigation (M6)", () => {
  it("PageUp/PageDown → pagePrev/pageNext, with or without a selection", () => {
    expect(resolveShortcut(kd("PageUp"), SEL)).toBe("pagePrev");
    expect(resolveShortcut(kd("PageDown"), SEL)).toBe("pageNext");
    expect(resolveShortcut(kd("PageUp"), NO_SEL)).toBe("pagePrev");
    expect(resolveShortcut(kd("PageDown"), NO_SEL)).toBe("pageNext");
  });

  it("ctrl+Home/ctrl+End → pageFirst/pageLast", () => {
    expect(resolveShortcut(kd("Home", { ctrl: true }), SEL)).toBe("pageFirst");
    expect(resolveShortcut(kd("End", { ctrl: true }), NO_SEL)).toBe("pageLast");
  });

  it("Home/End without ctrl stay unbound", () => {
    expect(resolveShortcut(kd("Home"), SEL)).toBeNull();
    expect(resolveShortcut(kd("End"), SEL)).toBeNull();
  });

  it("page navigation is suppressed while editing text", () => {
    expect(resolveShortcut(kd("PageUp"), EDITING)).toBeNull();
    expect(resolveShortcut(kd("PageDown"), EDITING)).toBeNull();
    expect(resolveShortcut(kd("Home", { ctrl: true }), EDITING)).toBeNull();
    expect(resolveShortcut(kd("1", { ctrl: true }), EDITING)).toBeNull();
  });
});

describe("resolveShortcut: unknown combos", () => {
  it("returns null for unbound keys and combos", () => {
    expect(resolveShortcut(kd("q", { ctrl: true }), SEL)).toBeNull();
    expect(resolveShortcut(kd("x"), SEL)).toBeNull(); // x without ctrl
    expect(resolveShortcut(kd("1"), SEL)).toBeNull();
    expect(resolveShortcut(kd(" "), SEL)).toBeNull();
    expect(resolveShortcut(kd("c", { ctrl: true, shift: true }), SEL)).toBeNull(); // ctrl+shift+c unbound
  });
});

// ---------------------------------------------------------------------------
// M6.13 conflict detection: the single-letter TOOL shortcuts (dispatched by
// useShortcuts BEFORE the resolver, only when no modifier is held) must never
// collide with a resolver binding — if the resolver claimed the same bare
// letter, one keypress would fire two different actions.
// ---------------------------------------------------------------------------

describe("tool-shortcut conflict detection (M6.13)", () => {
  it("no bare tool letter resolves to a resolver action (with or without selection)", async () => {
    const { toolShortcutKeys } = await import("@/components/editor/toolbarLayout");
    for (const letter of Object.keys(toolShortcutKeys())) {
      expect(resolveShortcut(kd(letter), SEL), `letter "${letter}" vs selection ctx`).toBeNull();
      expect(resolveShortcut(kd(letter), NO_SEL), `letter "${letter}" vs empty ctx`).toBeNull();
    }
  });

  it("tool letters keep resolving normally WITH ctrl (tool switch requires bare keys)", () => {
    // ctrl+c is copy, ctrl+v is paste, ctrl+s is save, ctrl+d duplicate,
    // ctrl+g group — the tool letters only switch tools when unmodified, so
    // these must stay bound in the resolver.
    expect(resolveShortcut(kd("c", { ctrl: true }), SEL)).toBe("copy");
    expect(resolveShortcut(kd("v", { ctrl: true }), SEL)).toBe("paste");
    expect(resolveShortcut(kd("s", { ctrl: true }), SEL)).toBe("save");
    expect(resolveShortcut(kd("d", { ctrl: true }), SEL)).toBe("duplicate");
    expect(resolveShortcut(kd("g", { ctrl: true }), SEL)).toBe("group");
  });

  it("tool letters are suppressed while editing text (resolver returns null there too)", () => {
    for (const letter of ["v", "h", "t", "i", "s", "n", "r", "o", "l", "d", "g", "e", "p", "c"]) {
      expect(resolveShortcut(kd(letter), EDITING)).toBeNull();
    }
  });
});
