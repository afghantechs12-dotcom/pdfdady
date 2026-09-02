import type { EditorColor } from "./objects";

/**
 * M5 Part 2 text-content contracts.
 *
 * A text object retains its legacy scalar fields and `text` projection for M1–M5
 * compatibility. `content` is the normalized source for future rich-text editing;
 * `frame` describes layout intent. The forthcoming TextLayoutEngine is the sole
 * owner of line breaking, fragment positions, auto-size results, and overflow —
 * none of those derived values are persisted here.
 */

/** Inline decoration applied to a text run. */
export type TextDecoration = "none" | "underline" | "line-through";

/** Semantic list treatment for a paragraph. */
export type TextListKind = "none" | "bulleted" | "numbered";

/** How content is aligned vertically within a fixed text frame. */
export type TextVerticalAlign = "top" | "middle" | "bottom";

/** Whether text wraps within its frame width. */
export type TextWrapMode = "wrap" | "nowrap";

/** Whether a frame grows with its resolved content or clips to localBounds. */
export type TextSizingMode = "auto-height" | "fixed";

/** Four-sided local-unit text-frame padding. */
export interface TextFramePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Column intent for a text frame. Fragment flow is resolved by TextLayoutEngine. */
export interface TextColumnConfig {
  count: number;
  gap: number;
}

/**
 * Optional overrides for one inline run. Absent values inherit the TextObject's
 * legacy scalar style, preserving old document appearance during the v3 → v4
 * migration and until a future renderer consumes rich runs.
 */
export interface TextRunStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  color?: EditorColor;
  opacity?: number;
  /** Additional character spacing in local PDF-point units. */
  letterSpacing?: number;
  /** Baseline offset in local units; positive values move toward the frame top. */
  baselineShift?: number;
  decoration?: TextDecoration;
  strokeColor?: EditorColor | null;
  strokeWidth?: number;
  /** Whether future layout/export should preserve font kerning where supported. */
  kerning?: boolean;
}

/** An immutable text segment carrying plain Unicode text plus optional overrides. */
export interface TextRun {
  text: string;
  style: TextRunStyle;
}

/** List configuration attached to a paragraph. */
export interface TextParagraphList {
  kind: TextListKind;
  /** Zero-based nesting depth. */
  level: number;
}

/** A block-level paragraph of ordered inline runs. */
export interface TextParagraph {
  runs: TextRun[];
  spacingBefore: number;
  spacingAfter: number;
  list: TextParagraphList;
}

/** Normalized rich-text source. Paragraph and run order is significant. */
export interface TextContent {
  paragraphs: TextParagraph[];
}

/** Persisted layout intent for a text object; resolved layout remains derived. */
export interface TextFrame {
  padding: TextFramePadding;
  verticalAlign: TextVerticalAlign;
  wrapMode: TextWrapMode;
  sizingMode: TextSizingMode;
  columns: TextColumnConfig;
}

/** Creates a single-paragraph plain-text content tree for legacy text. */
export function createPlainTextContent(text: string): TextContent {
  return {
    paragraphs: [
      {
        runs: [{ text, style: {} }],
        spacingBefore: 0,
        spacingAfter: 0,
        list: { kind: "none", level: 0 },
      },
    ],
  };
}

/** Returns a fresh default frame so editor objects never share mutable arrays/maps. */
export function createDefaultTextFrame(): TextFrame {
  return {
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    verticalAlign: "top",
    wrapMode: "wrap",
    sizingMode: "auto-height",
    columns: { count: 1, gap: 0 },
  };
}

/** Plain-text projection used by accessibility and legacy scalar render paths. */
export function textContentToPlainText(content: TextContent): string {
  return content.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n");
}
