import { describe, expect, it } from "vitest";
import {
  createDefaultTextFrame,
  createPlainTextContent,
  textContentToPlainText,
} from "./textContent";

describe("textContent", () => {
  it("creates a normalized single-paragraph plain-text compatibility tree", () => {
    expect(createPlainTextContent("Hello")).toEqual({
      paragraphs: [
        {
          runs: [{ text: "Hello", style: {} }],
          spacingBefore: 0,
          spacingAfter: 0,
          list: { kind: "none", level: 0 },
        },
      ],
    });
  });

  it("creates a fresh default frame for every text object", () => {
    const first = createDefaultTextFrame();
    const second = createDefaultTextFrame();
    first.padding.top = 12;
    first.columns.count = 2;

    expect(second).toEqual({
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      verticalAlign: "top",
      wrapMode: "wrap",
      sizingMode: "auto-height",
      columns: { count: 1, gap: 0 },
    });
  });

  it("projects ordered rich paragraphs and runs as plain text", () => {
    expect(
      textContentToPlainText({
        paragraphs: [
          {
            runs: [
              { text: "Hello", style: { fontWeight: 700 } },
              { text: " world", style: { italic: true } },
            ],
            spacingBefore: 0,
            spacingAfter: 4,
            list: { kind: "none", level: 0 },
          },
          {
            runs: [{ text: "Second", style: { decoration: "underline" } }],
            spacingBefore: 2,
            spacingAfter: 0,
            list: { kind: "bulleted", level: 0 },
          },
        ],
      }),
    ).toBe("Hello world\nSecond");
  });
});
