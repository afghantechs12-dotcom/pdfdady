import { beforeEach, describe, expect, it } from "vitest";
import { resetFactory } from "@/src/domain/editor/testFactories";
import { createEditorState, getActivePage, getObject } from "@/src/domain/editor/document";
import { isObjectKind } from "@/src/domain/editor/objects";
import { SetTextStyleCommand } from "./SetTextStyleCommand";
import { makeTextObject } from "@/src/domain/editor/testFactories";

describe("SetTextStyleCommand", () => {
  beforeEach(() => resetFactory());

  it("applies and inverts style changes correctly", () => {
    const state = createEditorState();
    const textObj = makeTextObject({
      content: {
        paragraphs: [
          {
            runs: [
              { text: "Hello", style: { fontSize: 12, fontWeight: 400, color: { r: 0, g: 0, b: 0, a: 1 } } },
              { text: " ", style: { fontSize: 12, fontWeight: 400, color: { r: 0, g: 0, b: 0, a: 1 } } },
              { text: "World", style: { fontSize: 12, fontWeight: 400, color: { r: 0, g: 0, b: 0, a: 1 } } },
            ],
            spacingBefore: 0,
            spacingAfter: 0,
            list: { kind: "none", level: 0 },
          },
        ],
      },
      fontSize: 12,
      fontFamily: "Helvetica",
      fontWeight: 400,
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: "left",
      lineHeight: 1.2,
    });

    const page = getActivePage(state);
    const updatedPage = {
      ...page,
      objects: {
        ...page.objects,
        [textObj.id]: textObj,
      },
    };
    const newState = { ...state, document: { ...state.document, pages: [updatedPage] } };

    // Test changing the first run's style
    const beforeStyle = { fontSize: 12, fontWeight: 400, color: { r: 0, g: 0, b: 0, a: 1 } };
    const afterStyle = { fontSize: 16, fontWeight: 700, color: { r: 1, g: 0, b: 0, a: 1 } };

    const cmd = new SetTextStyleCommand(textObj.id, 0, 0, beforeStyle, afterStyle);

    // Apply the command
    const appliedState = cmd.apply(newState);
    const appliedObj = getObject(getActivePage(appliedState), textObj.id);
    if (!appliedObj || !isObjectKind(appliedObj, "text")) {
      throw new Error("Applied object is not a text object");
    }

    // Check that the command properly changed the style
    expect(appliedObj.content.paragraphs[0].runs[0].style.fontSize).toBe(16);
    expect(appliedObj.content.paragraphs[0].runs[0].style.fontWeight).toBe(700);
    expect(appliedObj.content.paragraphs[0].runs[0].style.color?.r).toBe(1);
    expect(appliedObj.content.paragraphs[0].runs[0].style.color?.g).toBe(0);
    expect(appliedObj.content.paragraphs[0].runs[0].style.color?.b).toBe(0);

    // Invert the command
    const invertedState = cmd.invert(appliedState);
    const invertedObj = getObject(getActivePage(invertedState), textObj.id);
    if (!invertedObj || !isObjectKind(invertedObj, "text")) {
      throw new Error("Inverted object is not a text object");
    }

    // Check that the command properly reverted the style
    expect(invertedObj.content.paragraphs[0].runs[0].style.fontSize).toBe(12);
    expect(invertedObj.content.paragraphs[0].runs[0].style.fontWeight).toBe(400);
    expect(invertedObj.content.paragraphs[0].runs[0].style.color?.r).toBe(0);
    expect(invertedObj.content.paragraphs[0].runs[0].style.color?.g).toBe(0);
    expect(invertedObj.content.paragraphs[0].runs[0].style.color?.b).toBe(0);
  });

  it("handles multiple runs in the same paragraph", () => {
    const state = createEditorState();
    const textObj = makeTextObject({
      content: {
        paragraphs: [
          {
            runs: [
              { text: "Hello", style: { fontSize: 12, fontWeight: 400 } },
              { text: " ", style: { fontSize: 12, fontWeight: 400 } },
              { text: "World", style: { fontSize: 12, fontWeight: 400 } },
            ],
            spacingBefore: 0,
            spacingAfter: 0,
            list: { kind: "none", level: 0 },
          },
        ],
      },
      fontSize: 12,
      fontFamily: "Helvetica",
      fontWeight: 400,
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: "left",
      lineHeight: 1.2,
    });

    const page = getActivePage(state);
    const updatedPage = {
      ...page,
      objects: {
        ...page.objects,
        [textObj.id]: textObj,
      },
    };
    const newState = { ...state, document: { ...state.document, pages: [updatedPage] } };

    // Test changing the middle run's style
    const beforeStyle = { fontSize: 12, fontWeight: 400 };
    const afterStyle = { fontSize: 14, fontWeight: 700 };

    const cmd = new SetTextStyleCommand(textObj.id, 0, 1, beforeStyle, afterStyle);

    // Apply the command
    const appliedState = cmd.apply(newState);
    const appliedObj = getObject(getActivePage(appliedState), textObj.id);
    if (!appliedObj || !isObjectKind(appliedObj, "text")) {
      throw new Error("Applied object is not a text object");
    }

    // Check that only the middle run was changed
    expect(appliedObj.content.paragraphs[0].runs[0].style.fontSize).toBe(12);
    expect(appliedObj.content.paragraphs[0].runs[1].style.fontSize).toBe(14);
    expect(appliedObj.content.paragraphs[0].runs[2].style.fontSize).toBe(12);

    // Invert the command
    const invertedState = cmd.invert(appliedState);
    const invertedObj = getObject(getActivePage(invertedState), textObj.id);
    if (!invertedObj || !isObjectKind(invertedObj, "text")) {
      throw new Error("Inverted object is not a text object");
    }

    expect(invertedObj.content.paragraphs[0].runs[1].style.fontSize).toBe(12);
  });

  it("returns correct affected object IDs", () => {
    const textObj = makeTextObject();
    const cmd = new SetTextStyleCommand(textObj.id, 0, 0, {}, {});
    expect(cmd.getAffectedObjectIds()).toEqual([textObj.id]);
  });

  it("has correct label", () => {
    const textObj = makeTextObject();
    const cmd = new SetTextStyleCommand(textObj.id, 0, 0, {}, {});
    expect(cmd.label).toBe("Change text style");
  });
});