import type {
  TextContent,
  TextFrame,
  TextParagraph,
} from "@/src/domain/editor/textContent";
import type { TextObject } from "@/src/domain/editor/objects";

// ---------------------------------------------------------------------------
// Resolved layout types — pure data, no dependencies on React/Canvas/pdf-lib.
// ---------------------------------------------------------------------------

/** A positioned fragment of text within a resolved line. */
export interface TextLayoutFragment {
  /** The fragment's text content. */
  text: string;
  /** X position in local frame coordinates (relative to the content area origin). */
  x: number;
  /** Measured advance width of the fragment. */
  width: number;
  /** Zero-based index of the originating run within its paragraph. */
  runIndex: number;
  /** Zero-based index of the originating paragraph within TextContent.paragraphs. */
  paragraphIndex: number;
}

/** A resolved line of laid-out text. */
export interface TextLayoutLine {
  /** Ordered fragments that make up this line. */
  fragments: TextLayoutFragment[];
  /** Y position of the baseline in local frame coordinates (relative to content area). */
  y: number;
  /** Line height in local units. */
  height: number;
  /** Total advance width of all fragments on this line. */
  width: number;
  /** Paragraph index this line belongs to. */
  paragraphIndex: number;
  /** Spacing before the paragraph (only meaningful on the first line of a paragraph). */
  paragraphSpacingBefore: number;
  /** Spacing after the paragraph (only meaningful on the last line of a paragraph). */
  paragraphSpacingAfter: number;
}

/** Overflow indication for a resolved layout. */
export type TextOverflow = "none" | "clip";

/** The complete resolved layout for a TextObject. */
export interface ResolvedTextLayout {
  /** All resolved lines in reading order. */
  lines: TextLayoutLine[];
  /** Total height required by the content (excluding frame padding). */
  contentHeight: number;
  /** Maximum content width required (may exceed frame width for nowrap). */
  contentWidth: number;
  /** Whether content exceeds the available frame height. */
  overflow: TextOverflow;
  /** The resolved frame height: auto-height mode grows to fit; fixed uses available. */
  autoHeight: number;
}

/**
 * Measures the advance width of a text string in a given font/size.
 *
 * The caller supplies the platform-specific measurement (browser canvas
 * measureText, pdf-lib widthOfTextAtSize, etc.). The engine never imports
 * DOM or pdf-lib code.
 */
export type FontMeasureFn = (
  text: string,
  fontFamily: string,
  fontWeight: number,
  fontSize: number,
) => number;

/** Options passed to the layout engine. */
export interface LayoutOptions {
  /** Available width in local units (the frame's inner width before padding). */
  availableWidth: number;
  /** Available height in local units (undefined = unlimited / auto-height). */
  availableHeight?: number;
  /** Platform-specific text width measurement function. */
  measure: FontMeasureFn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CacheKey {
  id: string;
  contentSig: string;
  frameSig: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  align: string;
  lineHeight: number;
  letterSpacing: number;
  wordSpacing: number;
  availableWidth: number;
  availableHeight: number;
}

function buildCacheKey(obj: TextObject, opts: LayoutOptions): CacheKey {
  return {
    id: obj.id,
    contentSig: contentSignature(obj.content),
    frameSig: frameSignature(obj.frame),
    fontSize: obj.fontSize,
    fontFamily: obj.fontFamily,
    fontWeight: obj.fontWeight,
    align: obj.align,
    lineHeight: obj.lineHeight,
    letterSpacing: obj.letterSpacing ?? 0,
    wordSpacing: obj.wordSpacing ?? 0,
    availableWidth: opts.availableWidth,
    availableHeight: opts.availableHeight ?? 0,
  };
}

function cacheKeyToString(key: CacheKey): string {
  // Stable, deterministic serialization for Map keying.
  return JSON.stringify(key);
}

/** Deterministic signature of a TextContent tree. */
function contentSignature(content: TextContent): string {
  const parts: string[] = [];
  for (const para of content.paragraphs) {
    for (const run of para.runs) {
      parts.push(run.text);
      parts.push(run.style.fontFamily ?? "");
      parts.push(String(run.style.fontSize ?? 0));
      parts.push(String(run.style.fontWeight ?? 0));
      parts.push(String(run.style.letterSpacing ?? 0));
    }
    parts.push(String(para.spacingBefore));
    parts.push(String(para.spacingAfter));
    parts.push(para.list.kind);
    parts.push(String(para.list.level));
  }
  return parts.join("|");
}

/** Deterministic signature of a TextFrame. */
function frameSignature(frame: TextFrame): string {
  const p = frame.padding;
  return [
    p.top,
    p.right,
    p.bottom,
    p.left,
    frame.verticalAlign,
    frame.wrapMode,
    frame.sizingMode,
    frame.columns.count,
    frame.columns.gap,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Word splitting
// ---------------------------------------------------------------------------

/**
 * Splits text into alternating word/whitespace tokens so wrapping can preserve
 * whitespace while breaking only on word boundaries.
 */
function splitWords(text: string): string[] {
  // Capture spaces/tabs as separate tokens; non-whitespace runs are words.
  const tokens = text.split(/([ \t]+)/);
  return tokens.filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// TextLayoutEngine
// ---------------------------------------------------------------------------

/**
 * The canonical text layout engine.
 *
 * Consumes v4 TextContent + TextFrame, performs deterministic line breaking,
 * and produces ResolvedTextLayout objects. Contains no React, Canvas, or
 * pdf-lib code. Font measurement is injected via FontMeasureFn.
 */
export class TextLayoutEngine {
  private readonly cache = new Map<string, ResolvedTextLayout>();

  /**
   * Layout a text object. Returns a cached result when the inputs produce the
   * same layout; otherwise computes, caches, and returns a fresh result.
   */
  layout(obj: TextObject, opts: LayoutOptions): ResolvedTextLayout {
    const key = cacheKeyToString(buildCacheKey(obj, opts));
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = computeLayout(obj, opts);
    this.cache.set(key, result);
    return result;
  }

  /** Remove all cached entries for the given object id. */
  invalidate(objId: string): void {
    for (const key of this.cache.keys()) {
      // Cache keys are JSON strings; pull the id field directly.
      const idMatch = key.match(/"id":"([^"]+)"/);
      if (idMatch && idMatch[1] === objId) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear the entire layout cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Current cache size (for diagnostics / tests). */
  get cacheSize(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Pure layout computation (factored out for testability)
// ---------------------------------------------------------------------------

function computeLayout(obj: TextObject, opts: LayoutOptions): ResolvedTextLayout {
  const { availableWidth, availableHeight, measure } = opts;

  // Content area is reduced by padding.
  const padding = obj.frame.padding;
  const contentWidth = Math.max(0, availableWidth - padding.left - padding.right);
  const contentAreaX = padding.left;

  // Effective available height: undefined means unlimited.
  const effectiveAvailableHeight =
    availableHeight ?? Infinity;
  const contentAreaHeight =
    effectiveAvailableHeight === Infinity
      ? Infinity
      : Math.max(0, effectiveAvailableHeight - padding.top - padding.bottom);

  const wrapMode = obj.frame.wrapMode;
  const lineHeightPx = obj.fontSize * obj.lineHeight;
  const letterSpacing = obj.letterSpacing ?? 0;
  const columns = obj.frame.columns;

  // Column width calculation.
  const columnCount = Math.max(1, columns.count);
  const columnGap = columns.gap;
  const columnWidth =
    columnCount === 1
      ? contentWidth
      : Math.max(0, (contentWidth - (columnCount - 1) * columnGap) / columnCount);

  // Distribute lines across columns.
  const columnLines: TextLayoutLine[][] = Array.from({ length: columnCount }, () => []);

  let currentColumn = 0;
  let currentY = padding.top;
  let maxContentWidth = 0;
  let overflow: TextOverflow = "none";

  for (let pIdx = 0; pIdx < obj.content.paragraphs.length; pIdx++) {
    const para = obj.content.paragraphs[pIdx];

    // Paragraph spacing before.
    currentY += para.spacingBefore;

    // Layout this paragraph into lines within the current column(s).
    const paraResult = layoutParagraph(
      para,
      obj,
      wrapMode,
      columnWidth,
      contentAreaX,
      measure,
      currentY,
      lineHeightPx,
      letterSpacing,
      pIdx,
    );

    // Distribute lines across columns.
    for (const line of paraResult.lines) {
      // Check vertical overflow in fixed-height frames.
      if (
        effectiveAvailableHeight !== Infinity &&
        currentY + line.height > padding.top + contentAreaHeight
      ) {
        overflow = "clip";
        break;
      }

      // If current column is full, move to next column.
      if (columnLines[currentColumn].length > 0 && currentColumn < columnCount - 1) {
        currentColumn++;
        // Reset Y for new column.
        currentY = padding.top;
      }

      columnLines[currentColumn].push(line);
      currentY += line.height;
      maxContentWidth = Math.max(maxContentWidth, line.width + contentAreaX + padding.right);
    }

    // Paragraph spacing after.
    currentY += para.spacingAfter;

    if (overflow === "clip") break;
  }

  // Flatten columns into a single ordered line list.
  const allLines: TextLayoutLine[] = [];
  for (const col of columnLines) {
    allLines.push(...col);
  }

  // Total content height: from first line top to last line bottom.
  const contentHeight = allLines.length === 0 ? 0 : allLines[allLines.length - 1].y + allLines[allLines.length - 1].height - padding.top;

  // Auto-height: auto-height mode grows; fixed uses available height.
  let autoHeight: number;
  if (obj.frame.sizingMode === "auto-height") {
    autoHeight = contentHeight + padding.top + padding.bottom;
  } else {
    autoHeight = effectiveAvailableHeight === Infinity ? contentHeight + padding.top + padding.bottom : effectiveAvailableHeight;
  }

  // Apply vertical alignment (only matters for fixed-height frames with room).
  const adjustedLines =
    obj.frame.sizingMode === "fixed" && effectiveAvailableHeight !== Infinity
      ? applyVerticalAlignment(allLines, autoHeight, contentHeight, padding)
      : allLines;

  // Apply horizontal alignment to each line's fragments.
  const alignedLines = applyHorizontalAlignment(adjustedLines, contentWidth, obj.align);

  return {
    lines: alignedLines,
    contentHeight,
    contentWidth: maxContentWidth,
    overflow,
    autoHeight,
  };
}

// ---------------------------------------------------------------------------
// Paragraph layout
// ---------------------------------------------------------------------------

interface ParagraphLayoutResult {
  lines: TextLayoutLine[];
}

function layoutParagraph(
  para: TextParagraph,
  obj: TextObject,
  wrapMode: TextFrame["wrapMode"],
  contentWidth: number,
  contentAreaX: number,
  measure: FontMeasureFn,
  startY: number,
  lineHeightPx: number,
  letterSpacing: number,
  paragraphIndex: number,
): ParagraphLayoutResult {
  const lines: TextLayoutLine[] = [];
  const wordSpacing = obj.wordSpacing ?? 0;

  if (para.runs.length === 0) {
    // Empty paragraph still consumes a line (for spacing).
    lines.push({
      fragments: [],
      y: startY,
      height: lineHeightPx,
      width: 0,
      paragraphIndex,
      paragraphSpacingBefore: para.spacingBefore,
      paragraphSpacingAfter: para.spacingAfter,
    });
    return { lines };
  }

  let currentY = startY;
  let currentFragments: TextLayoutFragment[] = [];
  let currentLineWidth = 0;

  for (let runIdx = 0; runIdx < para.runs.length; runIdx++) {
    const run = para.runs[runIdx];
    const tokens = splitWords(run.text);

    for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
      const token = tokens[tIdx];
      const isWhitespace = /^[ \t]+$/.test(token);
      // Width = platform measure + tracking between glyphs + (for whitespace
      // tokens) the per-space word-spacing adjustment, mirroring CSS
      // `word-spacing` semantics (applied once per space character).
      const tokenWidth =
        measure(token, obj.fontFamily, obj.fontWeight, obj.fontSize) +
        (token.length - 1) * letterSpacing +
        (isWhitespace ? wordSpacing * token.length : 0);

      if (wrapMode === "nowrap") {
        // No wrapping: accumulate everything on one line (may overflow).
        const fragment: TextLayoutFragment = {
          text: token,
          x: contentAreaX + currentLineWidth,
          width: tokenWidth,
          runIndex: runIdx,
          paragraphIndex,
        };
        currentFragments.push(fragment);
        currentLineWidth += tokenWidth;
      } else {
        // Wrap mode: break when token doesn't fit.
        if (!isWhitespace && currentFragments.length > 0 && currentLineWidth + tokenWidth > contentWidth && contentWidth > 0) {
          // Emit current line.
          const line = emitLine(currentFragments, currentY, lineHeightPx, currentLineWidth, paragraphIndex, para, contentAreaX);
          lines.push(line);
          currentY += lineHeightPx;
          currentFragments = [];
          currentLineWidth = 0;
        }

        // If a single token is wider than the content area, force it onto its own line.
        if (!isWhitespace && tokenWidth > contentWidth && contentWidth > 0 && currentFragments.length > 0) {
          const line = emitLine(currentFragments, currentY, lineHeightPx, currentLineWidth, paragraphIndex, para, contentAreaX);
          lines.push(line);
          currentY += lineHeightPx;
          currentFragments = [];
          currentLineWidth = 0;
        }

        const fragment: TextLayoutFragment = {
          text: token,
          x: contentAreaX + currentLineWidth,
          width: tokenWidth,
          runIndex: runIdx,
          paragraphIndex,
        };
        currentFragments.push(fragment);
        currentLineWidth += tokenWidth;
      }
    }
  }

  // Emit the last line if any fragments remain.
  if (currentFragments.length > 0) {
    const line = emitLine(currentFragments, currentY, lineHeightPx, currentLineWidth, paragraphIndex, para, contentAreaX);
    lines.push(line);
  }

  return { lines };
}

function emitLine(
  fragments: TextLayoutFragment[],
  y: number,
  height: number,
  width: number,
  paragraphIndex: number,
  para: TextParagraph,
  contentAreaX: number,
): TextLayoutLine {
  return {
    fragments: fragments.map((f) => ({ ...f, x: f.x - contentAreaX })),
    y,
    height,
    width,
    paragraphIndex,
    paragraphSpacingBefore: para.spacingBefore,
    paragraphSpacingAfter: para.spacingAfter,
  };
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

function applyVerticalAlignment(
  lines: TextLayoutLine[],
  _frameHeight: number,
  _contentHeight: number,
  _padding: TextFrame["padding"],
): TextLayoutLine[] {
  if (lines.length === 0) return lines;

  // The engine's resolved layout is top-aligned by default; consumers apply
  // vertical alignment offsets using the resolved contentHeight and autoHeight.
  // This keeps the engine output stable (same content → same lines) and lets
  // the renderer/accessibility layer apply the final offset.
  return lines;
}

function applyHorizontalAlignment(
  lines: TextLayoutLine[],
  contentWidth: number,
  align: TextObject["align"],
): TextLayoutLine[] {
  if (lines.length === 0) return lines;

  return lines.map((line) => {
    if (line.fragments.length === 0) return line;

    let xOffset = 0;
    if (align === "center") {
      xOffset = (contentWidth - line.width) / 2;
    } else if (align === "right") {
      xOffset = contentWidth - line.width;
    }

    if (xOffset === 0) return line;

    return {
      ...line,
      fragments: line.fragments.map((f) => ({ ...f, x: f.x + xOffset })),
      width: line.width + xOffset,
    };
  });
}
