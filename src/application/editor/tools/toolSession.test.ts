import { describe, expect, it } from "vitest";
import {
  INITIAL_TOOL_SESSION,
  afterInsertion,
  isPinnable,
  pinHint,
  selectTool,
  setPinned,
  toolPersistence,
  toolStateLabel,
  type ToolSession,
} from "./toolSession";
import { ALL_EDITOR_TOOLS } from "@/components/editor/editorTypes";
import type { EditorTool } from "@/components/editor/editorTypes";

const armed = (active: EditorTool, pinned = false): ToolSession => ({ active, pinned });

describe("toolSession: persistence classification", () => {
  it("treats select, hand and crop as modes that stay until the user leaves", () => {
    for (const tool of ["select", "hand", "crop"] as const) {
      expect(toolPersistence(tool)).toBe("modal");
    }
  });

  it("treats draw and eraser as continuous, since disarming after one stroke is absurd", () => {
    for (const tool of ["draw", "eraser"] as const) {
      expect(toolPersistence(tool)).toBe("continuous");
    }
  });

  it("treats every insertion tool as one-shot", () => {
    for (const tool of [
      "text",
      "image",
      "signature",
      "annotation",
      "rect",
      "roundedRect",
      "ellipse",
      "circle",
      "triangle",
      "line",
      "arrow",
      "polygon",
      "star",
      "speechBubble",
      "connector",
      "highlight",
      "path",
    ] as const) {
      expect(toolPersistence(tool)).toBe("one-shot");
    }
  });

  it("classifies every tool in the union, with no gaps", () => {
    // A tool with no classification would fall through the canvas's insertion
    // policy and behave unpredictably.
    for (const tool of ALL_EDITOR_TOOLS) {
      expect(["modal", "one-shot", "continuous"]).toContain(toolPersistence(tool));
    }
  });

  it("makes only one-shot tools pinnable", () => {
    expect(isPinnable("rect")).toBe(true);
    expect(isPinnable("text")).toBe(true);
    expect(isPinnable("select")).toBe(false);
    expect(isPinnable("hand")).toBe(false);
    expect(isPinnable("crop")).toBe(false);
    expect(isPinnable("draw")).toBe(false);
  });
});

describe("toolSession: choosing a tool", () => {
  it("starts on Select, unpinned", () => {
    expect(INITIAL_TOOL_SESSION).toEqual({ active: "select", pinned: false });
  });

  it("arms a newly chosen tool unpinned", () => {
    expect(selectTool(INITIAL_TOOL_SESSION, "rect")).toEqual({ active: "rect", pinned: false });
  });

  it("pins a one-shot tool when it is chosen again while already armed", () => {
    const once = selectTool(INITIAL_TOOL_SESSION, "rect");
    expect(selectTool(once, "rect")).toEqual({ active: "rect", pinned: true });
  });

  it("unpins on a third choice, so the gesture is a toggle not a trap", () => {
    let session = selectTool(INITIAL_TOOL_SESSION, "rect");
    session = selectTool(session, "rect");
    expect(selectTool(session, "rect").pinned).toBe(false);
  });

  it("never arrives pre-pinned when switching to a different tool", () => {
    // A pin the user did not ask for is the "tool stayed armed and made an
    // object I didn't want" failure wearing a different hat.
    const pinnedRect = selectTool(selectTool(INITIAL_TOOL_SESSION, "rect"), "rect");
    expect(pinnedRect.pinned).toBe(true);
    expect(selectTool(pinnedRect, "ellipse")).toEqual({ active: "ellipse", pinned: false });
  });

  it("ignores a re-choose of an unpinnable tool rather than inventing a pin", () => {
    for (const tool of ["select", "hand", "crop", "draw"] as const) {
      const session = selectTool(INITIAL_TOOL_SESSION, tool);
      expect(selectTool(session, tool)).toBe(session);
    }
  });
});

describe("toolSession: explicit pin control", () => {
  it("pins and unpins a one-shot tool", () => {
    const session = armed("rect");
    expect(setPinned(session, true).pinned).toBe(true);
    expect(setPinned(armed("rect", true), false).pinned).toBe(false);
  });

  it("refuses to pin a tool that cannot be pinned", () => {
    for (const tool of ["select", "hand", "crop", "draw"] as const) {
      const session = armed(tool);
      expect(setPinned(session, true)).toBe(session);
    }
  });

  it("returns the same session when the pin already matches, so React can skip a render", () => {
    const session = armed("rect", true);
    expect(setPinned(session, true)).toBe(session);
  });
});

describe("toolSession: what happens after an insertion", () => {
  it("disarms an unpinned one-shot tool back to Select", () => {
    // The existing default, preserved: most insertions are one-off, and a
    // still-armed tool turns the next click into an unwanted object.
    expect(afterInsertion(armed("rect"))).toEqual({ active: "select", pinned: false });
    expect(afterInsertion(armed("text"))).toEqual({ active: "select", pinned: false });
  });

  it("keeps a pinned one-shot tool armed, so eight callouts take one tool choice", () => {
    const session = armed("speechBubble", true);
    expect(afterInsertion(session)).toBe(session);
  });

  it("survives repeated insertions while pinned", () => {
    let session = armed("rect", true);
    for (let i = 0; i < 5; i += 1) session = afterInsertion(session);
    expect(session).toEqual({ active: "rect", pinned: true });
  });

  it("leaves a continuous tool alone, so a stray call cannot end a stroke", () => {
    for (const tool of ["draw", "eraser"] as const) {
      const session = armed(tool);
      expect(afterInsertion(session)).toBe(session);
    }
  });

  it("leaves crop alone, because crop exits by applying or cancelling, not by inserting", () => {
    // Pinning must never keep a user trapped inside crop mode.
    const session = armed("crop");
    expect(afterInsertion(session)).toBe(session);
  });

  it("leaves Select alone rather than re-entering it", () => {
    const session = armed("select");
    expect(afterInsertion(session)).toBe(session);
  });

  it("reaches a settled state for every tool in the union", () => {
    // Applying the policy twice must not keep changing the answer, or the canvas
    // could oscillate between tools.
    for (const tool of ALL_EDITOR_TOOLS) {
      const once = afterInsertion(armed(tool));
      expect(afterInsertion(once)).toEqual(once);
    }
  });
});

describe("toolSession: state is described in words, not only in colour", () => {
  it("distinguishes one-shot from pinned in text a screen reader can read", () => {
    // The acceptance criterion: one-shot and pinned tools are clearly
    // distinguished, and active state must not rely on colour alone.
    const oneShot = toolStateLabel(armed("rect"));
    const pinned = toolStateLabel(armed("rect", true));
    expect(oneShot).not.toBe(pinned);
    expect(oneShot.toLowerCase()).toContain("one use");
    expect(pinned.toLowerCase()).toContain("pinned");
  });

  it("says a continuous tool keeps going", () => {
    expect(toolStateLabel(armed("draw")).toLowerCase()).toContain("keeps drawing");
  });

  it("says a modal tool is simply active, with no misleading pin language", () => {
    for (const tool of ["select", "hand", "crop"] as const) {
      const label = toolStateLabel(armed(tool));
      expect(label).toBe("active");
      expect(label).not.toContain("pin");
    }
  });

  it("gives every tool a non-empty label", () => {
    for (const tool of ALL_EDITOR_TOOLS) {
      for (const pinned of [false, true]) {
        expect(toolStateLabel(armed(tool, pinned)).length).toBeGreaterThan(0);
      }
    }
  });

  it("explains how to change the pin, and only where a pin is possible", () => {
    expect(pinHint(armed("rect"))).toContain("pin");
    expect(pinHint(armed("rect", true))).toContain("unpin");
    for (const tool of ["select", "hand", "crop", "draw"] as const) {
      expect(pinHint(armed(tool))).toBeNull();
    }
  });
});
