import type { EditorColor } from "@/src/domain/editor/objects";
import { DEFAULT_TEXT_COLOR } from "@/src/domain/editor/objects";
import { base14Ascent, base14Descent } from "@/src/domain/editor/textMetrics";

/**
 * Existing-text extraction (M5 Part 1) — the pure, PDF.js-free core.
 *
 * pdf-lib cannot mutate existing PDF text, so Part 1 turns existing text into
 * editable replacement objects: PDF.js `getTextContent` runs are grouped into
 * lines and re-created as `TextObject`s placed over the original, with an opaque
 * `background` that redacts the original text on screen and in export. This
 * module owns the PURE grouping/geometry logic — it takes a normalized stream of
 * raw text items (see {@link RawTextItem}) and emits line descriptors
 * ({@link ExtractedTextLine}) in EDITOR screen space (origin top-left, +y down).
 *
 * Keeping this PDF.js-free means the line-grouping algorithm — the load-bearing,
 * easy-to-get-wrong part — is unit-testable without a PDF.js worker. The thin
 * PDF.js adapter (`lib/editor/extractText.ts`) only translates a `TextContent`
 * into {@link RawTextItem}s and feeds them here.
 *
 * Coordinate contract: {@link RawTextItem.transform} is in PDF USER space
 * (origin bottom-left, +y up, the space `getTextContent` emits). This module
 * flips to editor screen space (origin top-left, +y down) using `pageHeight`, so
 * the emitted {@link ExtractedTextLine} primitives (baseline origin, advance,
 * ascent) are directly placeable as a `TextObject` whose transform is
 * `T(baseline) · R(θ) · T(0, −ascent)` (built by the adapter, which owns the
 * rotation-correct redaction box).
 */

/**
 * A normalized text item, in PDF user space. This is the shape the PDF.js
 * adapter produces from `TextContent.items` (filtering out marked-content
 * entries, which carry no `str`). `transform` is PDF.js's 6-element affine
 * `[a,b,c,d,e,f]`; `width`/`height` are the item's advance width and ascent in
 * PDF units at the item's scale.
 */
export interface RawTextItem {
  /** The item's text (may be a single glyph, a word, or a fragment). */
  str: string;
  /** `[a,b,c,d,e,f]` in PDF user space (origin bottom-left, +y up). */
  transform: [number, number, number, number, number, number];
  /** Advance width of `str` in PDF units (along the text baseline direction). */
  width: number;
  /** The resolved font name PDF.js reported (may be a generated id). */
  fontName?: string;
}

/**
 * A grouped line of existing text, in EDITOR screen space (top-left, +y down).
 *
 * Carries the geometric PRIMITIVES the adapter needs to build a rotation-correct
 * `TextObject` transform + redaction box: the baseline origin
 * (`baselineX`/`baselineY`), the text advance along its baseline (`advance`),
 * and the ascender height (`ascent`). The adapter places a rotated local box
 * `makeBounds(0, 0, advance, ascent × 1.25)` under `T(baseline) · R(θ) ·
 * T(0, −ascent)`, which exactly covers the original glyphs for any rotation —
 * tighter than an axis-aligned AABB, so it won't white out neighboring content.
 */
export interface ExtractedTextLine {
  /** The line's text content, with inter-item gaps turned into spaces. */
  text: string;
  /** Screen-space x of the line's baseline origin (where the first glyph starts). */
  baselineX: number;
  /** Screen-space y of the line's baseline origin (= pageHeight − pdf f). */
  baselineY: number;
  /** Text advance width along the baseline direction, in points. */
  advance: number;
  /**
   * Ascender height (baseline-to-top), in points — the MAPPED base-14 font's
   * ascender (see {@link base14Ascent}), NOT PDF.js's `item.height` (which is
   * the font size). This is the value the adapter's `T(0, −ascent)` shift and
   * the render/export baseline anchor must share so the redrawn text lands on
   * the original baseline.
   */
  ascent: number;
  /**
   * Descender magnitude (baseline-to-bottom), in points — the mapped base-14
   * font's descender (see {@link base14Descent}). The redaction box height is
   * `ascent + descent` so it covers the original glyph run.
   */
  descent: number;
  /** Font size in points (the text scale, derived from the transform). */
  fontSize: number;
  /** Rotation in degrees (0/90/180/270 for clean groupings; the raw angle otherwise). */
  rotation: number;
  /** The font name reported by PDF.js (for provenance display). */
  fontName?: string;
  /** Best-effort text color (PDF.js doesn't expose fill color stably → black). */
  color: EditorColor;
}

/** A rounding tolerance for "same baseline" comparisons, in PDF units. */
const SAME_BASELINE_TOL = 1.5;
/** Gap (in PDF units, relative to font size) above which a space is inserted. */
const SPACE_GAP_RATIO = 0.18;
/** Minimum font size to keep (filters out 0-size / degenerate items). */
const MIN_FONT_SIZE = 1;
/**
 * Resource bounds (M5 Part 1 security/perf hardening). A crafted PDF can emit a
 * pathologically large text-content stream; these caps bound the CPU/memory of
 * grouping so a malicious or huge page can't freeze the tab or exhaust memory.
 * Items beyond these limits are dropped (documented truncation, never a crash).
 */
export const MAX_ITEMS_PER_LINE = 5_000;
export const MAX_LINE_TEXT_LENGTH = 5_000;

/**
 * Extracts the font size (the text scale) from a PDF.js transform. The scale is
 * the magnitude of the first column vector `(a,b)`: `sqrt(a² + b²)`. For
 * unrotated text `b = 0` so this is `|a|`; for 90° text `a = 0` so it's `|b|`.
 */
export function fontSizeFromTransform(transform: RawTextItem["transform"]): number {
  const [a, b] = transform;
  return Math.hypot(a, b);
}

/**
 * Extracts the rotation in degrees from a PDF.js transform, normalized to
 * [0, 360). The angle is `atan2(b, a)` — the direction of the first column
 * vector, which is the text's baseline direction.
 */
export function rotationFromTransform(transform: RawTextItem["transform"]): number {
  const [a, b] = transform;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * Snaps a degree value to the nearest of 0/90/180/270 when within `tol` degrees,
 * returning the snapped cardinal. Returns `null` when the angle is NOT near a
 * cardinal direction — the caller uses that to emit the item as its own line
 * rather than risk fragile arbitrary-angle grouping.
 */
function snapToCardinal(deg: number, tol = 2): number | null {
  const candidates = [0, 90, 180, 270, 360];
  for (const c of candidates) {
    if (Math.abs(deg - c) <= tol) return c % 360;
  }
  return null;
}

/** The baseline origin (e, f) flipped to screen space (x, pageHeight - f). */
function baselineScreen(item: RawTextItem, pageHeight: number): { x: number; y: number } {
  const [, , , , e, f] = item.transform;
  return { x: e, y: pageHeight - f };
}

/**
 * Groups raw text items into editable lines.
 *
 * Items are grouped by (snapped rotation, baseline cross-axis coordinate): two
 * items join the same line when their rotations snap to the same cardinal
 * direction AND their baselines sit within {@link SAME_BASELINE_TOL} on the
 * cross-axis (screen y for horizontal text, screen x for vertical text). Within
 * a line, items are ordered along the main axis and inter-item gaps larger than
 * {@link SPACE_GAP_RATIO} × font size become spaces; smaller gaps concatenate
 * (PDF.js often splits a word into several items). The emitted line carries the
 * baseline-origin + advance + ascent primitives; the adapter builds a rotated
 * redaction box from those that covers the original glyphs for any rotation.
 *
 * Items whose rotation does NOT snap to a cardinal direction are emitted as
 * their own single-item lines (still editable, just not merged) — keeping the
 * common horizontal/vertical case precise without fragile arbitrary-angle
 * grouping.
 *
 * @param items Raw text items in PDF user space.
 * @param pageHeight The PDF page height in points (at scale 1) — used to flip y.
 * @param color Optional override for the text color (defaults to near-black).
 */
export function groupTextItemsIntoLines(
  items: RawTextItem[],
  pageHeight: number,
  color: EditorColor = DEFAULT_TEXT_COLOR,
): ExtractedTextLine[] {
  // Skip empty/whitespace-only and degenerate items. Whitespace items carry no
  // glyph box worth redacting and would inject stray gaps; their effect on
  // spacing is captured by the gap-between-items logic below.
  const usable = items.filter(
    (it) => it.str.length > 0 && it.str.trim().length > 0 && fontSizeFromTransform(it.transform) >= MIN_FONT_SIZE,
  );

  // Bucket each item by (snapped rotation, rounded cross-axis baseline).
  const buckets = new Map<string, RawTextItem[]>();
  const keyOf = (item: RawTextItem): string | null => {
    const deg = rotationFromTransform(item.transform);
    const snapped = snapToCardinal(deg);
    // Only merge items on a cardinal axis; arbitrary angles get their own line.
    if (snapped === null) return null;
    const base = baselineScreen(item, pageHeight);
    const horizontal = snapped === 0 || snapped === 180;
    const cross = horizontal ? base.y : base.x;
    return `${snapped}:${Math.round(cross / SAME_BASELINE_TOL)}`;
  };

  let unique = 0;
  for (const item of usable) {
    const key = keyOf(item);
    const bucketKey = key ?? `~${unique++}`;
    const arr = buckets.get(bucketKey);
    if (arr) {
      // Cap items per line: a pathological same-baseline stream can't grow a
      // single bucket unbounded (bounds the sort + text concatenation).
      if (arr.length < MAX_ITEMS_PER_LINE) arr.push(item);
    } else {
      buckets.set(bucketKey, [item]);
    }
  }

  const lines: ExtractedTextLine[] = [];
  for (const [, bucket] of buckets) {
    const firstRot = rotationFromTransform(bucket[0].transform);
    const snapped = snapToCardinal(firstRot);
    // Non-cardinal buckets fall back to the raw angle for the line's rotation.
    const rotation = snapped ?? firstRot;
    const horizontal = rotation === 0 || rotation === 180;

    // Decorate each item with its screen baseline ONCE. The sort comparator and
    // the gap/text loop both need the cross-axis coordinate; computing it here
    // (O(k)) avoids recomputing baselineScreen O(k log k) times inside the sort.
    const decorated = bucket
      .map((it) => ({ it, base: baselineScreen(it, pageHeight) }))
      .sort((p, q) => (horizontal ? p.base.x - q.base.x : p.base.y - q.base.y));
    const ordered = decorated.map((d) => d.it);

    // Build the text, inserting a space when the gap between items exceeds the
    // space threshold. Concatenate tightly otherwise (PDF.js word fragments).
    // Capped at MAX_LINE_TEXT_LENGTH so one pathological line can't produce a
    // multi-MB string that hangs SVG render / pdf-lib text measurement.
    let text = "";
    let prevEnd = -Infinity;
    let prevSize = 0;
    for (const { it, base } of decorated) {
      if (text.length >= MAX_LINE_TEXT_LENGTH) break;
      const size = fontSizeFromTransform(it.transform);
      const start = horizontal ? base.x : base.y;
      if (text.length > 0) {
        const gap = start - prevEnd;
        const spaceThreshold = SPACE_GAP_RATIO * (prevSize || size);
        text += gap > spaceThreshold ? " " : "";
      }
      // Truncate the final fragment so the cap is respected exactly.
      const remaining = MAX_LINE_TEXT_LENGTH - text.length;
      text += it.str.length > remaining ? it.str.slice(0, remaining) : it.str;
      prevEnd = start + it.width;
      prevSize = size;
    }

    // Use the max font size across the line (mixed sizes in one line are rare;
    // the max keeps the editable size legible). Loop-based max (not
    // Math.max(...spread)) so a huge line can't blow the call-stack argument limit.
    let fontSize = 0;
    for (const it of ordered) {
      const s = fontSizeFromTransform(it.transform);
      if (s > fontSize) fontSize = s;
    }

    // Geometric primitives for the rotation-correct transform. The baseline
    // direction unit vector (ux, uy) comes from the first item's transform
    // (all items in a line share the same rotation). Project each item's
    // baseline start/end onto that direction to get the line advance + the
    // baseline origin (the start of the earliest item along the baseline).
    const first = ordered[0];
    const firstSize = fontSizeFromTransform(first.transform) || 1;
    // Only the first two coefficients (a, b) set the baseline direction; the
    // baseline ORIGIN comes from the earliest item below, not from `first`.
    const [fa, fb] = first.transform;
    const ux = fa / firstSize;
    const uy = fb / firstSize;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    let startItem = ordered[0];
    for (const item of ordered) {
      const [, , , , ie, ifl] = item.transform;
      const start = ie * ux + ifl * uy; // PDF-space projection along baseline dir
      const end = start + item.width;
      if (start < minStart) {
        minStart = start;
        startItem = item;
      }
      if (end > maxEnd) maxEnd = end;
    }
    const advance = Math.max(maxEnd - minStart, 1);
    const [, , , , se, sf] = startItem.transform;
    const baselineX = se;
    const baselineY = pageHeight - sf;
    // Vertical metrics for the MAPPED base-14 font (not PDF.js's `item.height`,
    // which is the text-matrix vertical scale = the font SIZE, not the ascender).
    // The adapter's `T(0, −ascent)` shift and the render/export baseline anchor
    // both consume `ascent`, so it must be the base-14 ascender — otherwise the
    // redrawn text floats ~0.28×fontSize above the original baseline. The
    // redaction box is `ascent + descent` so it covers the original glyph run
    // (ascender + descender) for any rotation. See {@link textMetrics}.
    const { fontFamily: mappedFamily } = mapFontToBaseFamily(ordered[0].fontName);
    const ascent = base14Ascent(mappedFamily, fontSize);
    const descent = base14Descent(mappedFamily, fontSize);

    lines.push({
      text,
      baselineX,
      baselineY,
      advance,
      ascent,
      descent,
      fontSize,
      rotation,
      fontName: ordered[0].fontName,
      color,
    });
  }

  // Stable, readable order: top-to-bottom by baseline, then left-to-right.
  lines.sort((a, b) => a.baselineY - b.baselineY || a.baselineX - b.baselineX);
  return lines;
}

/**
 * Maps a PDF.js font name to the closest PDF base-14 family for the editable
 * `TextObject`. PDF.js resolved names are often opaque ids (`g_d0_f1`), so this
 * is best-effort: a name mentioning serif → Times, mono/courier → Courier, sans
 * or unknown → Helvetica. Weight 400 unless the name mentions "bold". The
 * ORIGINAL name is preserved on the object's `sourceText.fontName` for display.
 */
export function mapFontToBaseFamily(fontName: string | undefined): {
  fontFamily: string;
  fontWeight: number;
} {
  const name = (fontName ?? "").toLowerCase();
  if (name.includes("bold")) return { fontFamily: "Helvetica-Bold", fontWeight: 700 };
  const isSerif = name.includes("serif") || name.includes("times") || name.includes("roman");
  const isMono = name.includes("mono") || name.includes("courier");
  if (isSerif) return { fontFamily: "Times-Roman", fontWeight: 400 };
  if (isMono) return { fontFamily: "Courier", fontWeight: 400 };
  return { fontFamily: "Helvetica", fontWeight: 400 };
}
