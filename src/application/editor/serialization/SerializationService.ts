import { z } from "zod";
import { EDITOR_FORMAT_VERSION, type EditorState } from "@/src/domain/editor/document";
import { normalizeImportedText } from "@/src/application/editor/text/normalizeImportedText";
import type { Bounds } from "@/src/domain/editor/geometry";
import { sanitizeCrop } from "@/src/application/editor/tools/cropMath";
import {
  MAX_EDITOR_IMAGE_SOURCE_LENGTH,
  validateImageDataUrl,
  validateImageDimensions,
} from "@/src/application/editor/imageValidation";
import {
  createDefaultTextFrame,
  createPlainTextContent,
  textContentToPlainText,
  type TextColumnConfig,
  type TextContent,
  type TextFrame,
  type TextFramePadding,
  type TextParagraph,
  type TextParagraphList,
  type TextRun,
  type TextRunStyle,
} from "@/src/domain/editor/textContent";
import type {
  EditorDocument,
  EditorPage,
  SelectionState,
} from "@/src/domain/editor/document";
import type { Layer, LayerStack } from "@/src/domain/editor/layers";
import type {
  AnyEditorObject,
  ArrowHeadType,
  BrushKind,
  ConnectorKind,
  EditorColor,
  EditorObject,
  ObjectStyle,
  ReconstructedBase,
  ShapeKind,
  ShapeShadow,
} from "@/src/domain/editor/objects";
import {
  DEFAULT_ANNOTATION_BACKGROUND,
  DEFAULT_ANNOTATION_BORDER_WIDTH,
  DEFAULT_ANNOTATION_CORNER_RADIUS,
  DEFAULT_TEXT_COLOR,
} from "@/src/domain/editor/objects";
import {
  ALL_SHAPE_KINDS,
  clampHeadSize,
  clampInnerRatio,
  clampSides,
  clampStarPoints,
  clampTailPosition,
  normalizePathData,
} from "@/src/domain/editor/shapeGeometry";
import type { ObjectTypeRegistry } from "../registry";
import type { ISerializer, SerializedEditorState } from "../ports/ISerializer";

/**
 * Versioned serialization for the editor.
 *
 * The serialized envelope is `{ format, version, document, activePageId,
 * selection }`. Serialize JSON-clones the live state into that envelope at the
 * current format version; deserialize validates the envelope with zod, migrates
 * an older version up to {@link EDITOR_FORMAT_VERSION}, and reconstructs live
 * state — validating required fields and throwing a clear error on malformed
 * input rather than silently producing a half-built document.
 *
 * Plugin object kinds (outside the built-in union) round-trip through the
 * {@link ObjectTypeRegistry}: if a plugin registered a serialize/deserialize for
 * its kind, that is used; otherwise the object is stored/restored generically as
 * a PluginEditorObject so unknown kinds still survive a save/load.
 */

const FORMAT_ID = "pdfdadi-editor";

/** A per-version migration: upgrades `data` from `fromVersion` to fromVersion+1. */
type Migration = (data: SerializedEditorState) => SerializedEditorState;

/** Registered migrations keyed by the version they upgrade FROM. */
const migrations = new Map<number, Migration>();

/** Registers a migration from `fromVersion` → `fromVersion + 1`. */
export function registerMigration(fromVersion: number, migration: Migration): void {
  if (migrations.has(fromVersion)) {
    throw new Error(`Migration from version ${fromVersion} is already registered.`);
  }
  migrations.set(fromVersion, migration);
}

/**
 * Brings an older serialized envelope up to the target format version (the
 * current version by default). Exported so the migration machinery can be tested
 * without bumping {@link EDITOR_FORMAT_VERSION}: a test registers a migration
 * and calls `migrate(data, targetVersion)` directly.
 */
export function migrate(
  data: SerializedEditorState,
  targetVersion = EDITOR_FORMAT_VERSION,
): SerializedEditorState {
  let current = data;
  while (current.version < targetVersion) {
    const step = migrations.get(current.version);
    if (!step) {
      throw new Error(
        `No migration path from serialized version ${current.version}; current is ${targetVersion}.`,
      );
    }
    current = step(current);
  }
  return current;
}

// Real v1 → v2 migration: backfill the optional fields added in M4 (text
// `letterSpacing`, image `crop`) onto every object so a v1 save upgrades to the
// current shape. Reconstruction also defaults missing fields, so this is
// belt-and-suspenders — but it keeps the on-disk shape explicit and testable.
registerMigration(1, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    const objects = page.objects;
    if (!objects || typeof objects !== "object") continue;
    for (const obj of Object.values(objects as Record<string, Record<string, unknown>>)) {
      if (!obj || typeof obj !== "object") continue;
      if (obj.kind === "text" && obj.letterSpacing === undefined) obj.letterSpacing = 0;
      if (obj.kind === "image" && obj.crop === undefined) obj.crop = null;
    }
  }
  return { ...data, version: 2 };
});

// Real v2 → v3 migration (M5 Part 1): backfill the optional text fields
// `background` (null = transparent, the pre-v3 behavior) and `sourceText` (null
// = editor-authored, not existing-text-derived) onto every text object so a v2
// save upgrades to the current shape. Reconstruction also defaults missing
// fields, so this is belt-and-suspenders — but it keeps the on-disk shape
// explicit and testable, and lets a v2 save round-trip through serialize again
// at v3 without losing the defaults.
registerMigration(2, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    const objects = page.objects;
    if (!objects || typeof objects !== "object") continue;
    for (const obj of Object.values(objects as Record<string, Record<string, unknown>>)) {
      if (!obj || typeof obj !== "object") continue;
      if (obj.kind === "text") {
        if (obj.background === undefined) obj.background = null;
        if (obj.sourceText === undefined) obj.sourceText = null;
      }
    }
  }
  return { ...data, version: 3 };
});

// Real v3 → v4 migration (M5 Part 2): normalize each legacy text string into a
// single paragraph/run and attach default frame intent. The legacy scalar `text`
// remains untouched as the compatibility projection used by the existing M4/M5
// renderer/exporter until the shared TextLayoutEngine is introduced.
registerMigration(3, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    const objects = page.objects;
    if (!objects || typeof objects !== "object") continue;
    for (const obj of Object.values(objects as Record<string, Record<string, unknown>>)) {
      if (!obj || typeof obj !== "object" || obj.kind !== "text") continue;
      if (obj.content === undefined) {
        obj.content = createPlainTextContent(typeof obj.text === "string" ? obj.text : "");
      }
      if (obj.frame === undefined) obj.frame = createDefaultTextFrame();
    }
  }
  return { ...data, version: 4 };
});

// Real v4 → v5 migration (M6 page operations): backfill `sourcePageIndex` with
// each page's ARRAY INDEX. Pre-v5 export mapped editor page i → source PDF page
// i by index, so the array index is the exact historical mapping for old saves;
// from v5 on the field pins pages to their source across insert/delete/
// duplicate/reorder. Only missing fields are backfilled — a page that somehow
// already carries the field keeps it.
registerMigration(4, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  pages.forEach((page, index) => {
    if (!page || typeof page !== "object") return;
    if (page.sourcePageIndex === undefined) page.sourcePageIndex = index;
  });
  return { ...data, version: 5 };
});

// Real v5 → v6 migration (M6 shape library + drawing upgrade): backfill the new
// optional style/drawing fields with their explicit pre-v6 defaults so a v5
// save upgrades to the current shape. `shadow: null` = no shadow, `brush: "pen"`
// + `smoothing: false` = the pre-v6 stroke look. Per-kind shape parameters
// (`sides`, `starPoints`, …) stay absent — the canonical geometry module derives
// their defaults at render time, and only the kinds that use them carry them.
// Reconstruction also defaults missing fields, so this is belt-and-suspenders —
// but it keeps the on-disk shape explicit and testable, matching 1→2/2→3/3→4.
registerMigration(5, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    const objects = page.objects;
    if (!objects || typeof objects !== "object") continue;
    for (const obj of Object.values(objects as Record<string, Record<string, unknown>>)) {
      if (!obj || typeof obj !== "object") continue;
      if (obj.kind === "shape" || obj.kind === "drawing") {
        const style = obj.style;
        if (style && typeof style === "object" && (style as Record<string, unknown>).shadow === undefined) {
          (style as Record<string, unknown>).shadow = null;
        }
      }
      if (obj.kind === "drawing") {
        if (obj.brush === undefined) obj.brush = "pen";
        if (obj.smoothing === undefined) obj.smoothing = false;
      }
    }
  }
  return { ...data, version: 6 };
});

// Real v6 → v7 migration (Phase 3 canonical annotation container): backfill the
// note panel that used to exist only as a hardcoded `fill` in the canvas
// renderer. Every pre-v7 annotation was DRAWN with `rgba(255,245,180,0.95)`, a
// 1px hairline in its own text color and `rx=6`, so those are the exact values a
// pre-v7 save is worth — writing them explicitly is what keeps a document saved
// before this change looking identical after it, and what lets the exporter draw
// the same panel the canvas does instead of guessing.
//
// `border` is the object's OWN color rather than a constant: the old renderer used
// `stroke={editorColorToCss(color)}`, so a note authored in red had a red hairline.
registerMigration(6, (data) => {
  const doc = data.document as Record<string, unknown>;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    const objects = page.objects;
    if (!objects || typeof objects !== "object") continue;
    for (const obj of Object.values(objects as Record<string, Record<string, unknown>>)) {
      if (!obj || typeof obj !== "object" || obj.kind !== "annotation") continue;
      if (obj.background === undefined) obj.background = { ...DEFAULT_ANNOTATION_BACKGROUND };
      if (obj.border === undefined) {
        obj.border =
          obj.color && typeof obj.color === "object"
            ? { ...(obj.color as Record<string, unknown>) }
            : { ...DEFAULT_TEXT_COLOR };
      }
      if (obj.borderWidth === undefined) obj.borderWidth = DEFAULT_ANNOTATION_BORDER_WIDTH;
      if (obj.cornerRadius === undefined) obj.cornerRadius = DEFAULT_ANNOTATION_CORNER_RADIUS;
    }
  }
  return { ...data, version: 7 };
});

// The envelope schema validates the top-level shape; per-field validation happens
// during reconstruction (where we can throw field-specific errors).
const envelopeSchema = z.object({
  format: z.literal(FORMAT_ID),
  version: z.number().int().min(1),
  document: z.record(z.unknown()),
  activePageId: z.string(),
  selection: z.record(z.unknown()),
});

/** Deep, JSON-safe clone (the model is pure JSON data — no Dates/functions). */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Serialized field "${field}" is not a finite number.`);
  }
  return value;
}

/**
 * Hard cap on reconstructed string lengths (M5 Part 1 resource bound). A crafted
 * editor-save file could otherwise supply multi-megabyte `text`/`name`/`src`
 * strings that hang SVG render or pdf-lib text measurement. 200k chars is far
 * beyond any legitimate single field and keeps round-trips bounded.
 */
const MAX_STRING_LENGTH = 200_000;

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Serialized field "${field}" is not a string.`);
  }
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
}

function assertImageSource(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_EDITOR_IMAGE_SOURCE_LENGTH) {
    throw new Error(`Serialized field "${field}" is not a bounded image source.`);
  }
  try {
    return validateImageDataUrl(value).source;
  } catch (error) {
    throw new Error(`Serialized field "${field}" is not a supported image source.`, { cause: error });
  }
}

function assertSafeObjectId(value: unknown, field: string): string {
  const id = assertString(value, field);
  if (id === "__proto__" || id === "prototype" || id === "constructor") {
    throw new Error(`Serialized field "${field}" contains a forbidden object id.`);
  }
  return id;
}

/**
 * Reads an optional finite number, returning `fallback` when the field is
 * absent or non-finite (so older saves that predate the field upgrade cleanly).
 * Use for fields added after v1; required fields still use {@link assertFinite}.
 */
function optFinite(value: unknown, field: string, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return fallback;
  throw new Error(`Serialized field "${field}" is not a finite number.`);
}

/** Reads an optional Bounds (e.g. an image crop), returning null when absent. */
function optBounds(value: unknown, field: string): Bounds | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") {
    throw new Error(`Serialized field "${field}" is not a bounds object or null.`);
  }
  const r = value as Record<string, unknown>;
  return {
    x: assertFinite(r.x, `${field}.x`),
    y: assertFinite(r.y, `${field}.y`),
    width: assertFinite(r.width, `${field}.width`),
    height: assertFinite(r.height, `${field}.height`),
  };
}

/**
 * Reads an optional {@link EditorColor}, returning null when absent (the
 * pre-v3 transparent default for text `background`). A present-but-malformed
 * color throws, matching the strictness of required color fields.
 */
function optColor(value: unknown, field: string): EditorColor | null {
  if (value === null || value === undefined) return null;
  return reconstructColor(value, field);
}

/**
 * Reads an optional `sourceText` provenance object, returning null when absent
 * (the pre-v3 default — editor-authored text). A present object is validated
 * leniently: only finite numbers are accepted for `rotation`, only strings for
 * `fontName`, and only the three known values for `mode`; anything else is
 * dropped rather than thrown, so a partially-corrupt provenance marker never
 * blocks loading a document.
 *
 * A DROPPED `mode` is the conservative outcome, not a permissive one: an absent
 * mode marks the object as a legacy copy, and `normalizeImportedText` then
 * classifies it (unchanged → readonly, modified → replace). A corrupt marker
 * therefore lands on the safe path rather than being treated as editable.
 */
function optSourceText(value: unknown): import("@/src/domain/editor/objects").SourceTextInfo | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const out: import("@/src/domain/editor/objects").SourceTextInfo = {};
  // Cap fontName length (same resource bound as assertString) so a crafted
  // provenance marker can't carry an unbounded string into the UI/export.
  if (typeof r.fontName === "string") {
    out.fontName = r.fontName.length > MAX_STRING_LENGTH ? r.fontName.slice(0, MAX_STRING_LENGTH) : r.fontName;
  }
  if (typeof r.rotation === "number" && Number.isFinite(r.rotation)) out.rotation = r.rotation;
  if (r.mode === "direct" || r.mode === "replace" || r.mode === "readonly") out.mode = r.mode;
  if (typeof r.reason === "string") {
    out.reason = r.reason.length > MAX_STRING_LENGTH ? r.reason.slice(0, MAX_STRING_LENGTH) : r.reason;
  } else if (r.reason === null) {
    out.reason = null;
  }
  if (typeof r.originalText === "string") {
    out.originalText =
      r.originalText.length > MAX_STRING_LENGTH ? r.originalText.slice(0, MAX_STRING_LENGTH) : r.originalText;
  }
  return out;
}

function reconstructColor(raw: unknown, field: string): EditorColor {
  if (!raw || typeof raw !== "object") throw new Error(`Serialized "${field}" is missing.`);
  const r = raw as Record<string, unknown>;
  return {
    r: assertFinite(r.r, `${field}.r`),
    g: assertFinite(r.g, `${field}.g`),
    b: assertFinite(r.b, `${field}.b`),
    a: assertFinite(r.a, `${field}.a`),
  };
}

/** Resource and semantic limits for the normalized M5 Part 2 text model. */
const MAX_TEXT_PARAGRAPHS = 10_000;
const MAX_TEXT_RUNS = 20_000;
const MAX_TEXT_CONTENT_LENGTH = MAX_STRING_LENGTH;
const MAX_TEXT_FRAME_PADDING = 10_000;
const MAX_TEXT_COLUMNS = 12;
const MAX_TEXT_COLUMN_GAP = 10_000;
const MAX_TEXT_FONT_SIZE = 1_000;
const MAX_TEXT_LETTER_SPACING = 1_000;
const MAX_TEXT_BASELINE_SHIFT = 10_000;
const MAX_TEXT_STROKE_WIDTH = 1_000;
const MAX_TEXT_PARAGRAPH_SPACING = 10_000;
const MAX_TEXT_LIST_LEVEL = 8;

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Serialized field "${field}" is not an object.`);
  }
  return value as Record<string, unknown>;
}

function assertBoundedFinite(value: unknown, field: string, min: number, max: number): number {
  const number = assertFinite(value, field);
  if (number < min || number > max) {
    throw new Error(`Serialized field "${field}" must be between ${min} and ${max}.`);
  }
  return number;
}

function reconstructTextRunStyle(raw: unknown, field: string): TextRunStyle {
  if (raw === undefined || raw === null) return {};
  const r = assertRecord(raw, field);
  const decoration = r.decoration;
  if (decoration !== undefined && decoration !== "none" && decoration !== "underline" && decoration !== "line-through") {
    throw new Error(`Serialized field "${field}.decoration" is invalid.`);
  }
  const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new Error(`Serialized field "${name}" is not a boolean.`);
    return value;
  };
  return {
    ...(r.fontFamily === undefined || r.fontFamily === null
      ? {}
      : { fontFamily: assertString(r.fontFamily, `${field}.fontFamily`) }),
    ...(r.fontSize === undefined || r.fontSize === null
      ? {}
      : { fontSize: assertBoundedFinite(r.fontSize, `${field}.fontSize`, 1, MAX_TEXT_FONT_SIZE) }),
    ...(r.fontWeight === undefined || r.fontWeight === null
      ? {}
      : { fontWeight: assertBoundedFinite(r.fontWeight, `${field}.fontWeight`, 100, 900) }),
    ...(optionalBoolean(r.italic, `${field}.italic`) === undefined
      ? {}
      : { italic: optionalBoolean(r.italic, `${field}.italic`) }),
    ...(r.color === undefined || r.color === null ? {} : { color: reconstructColor(r.color, `${field}.color`) }),
    ...(r.opacity === undefined || r.opacity === null
      ? {}
      : { opacity: assertBoundedFinite(r.opacity, `${field}.opacity`, 0, 1) }),
    ...(r.letterSpacing === undefined || r.letterSpacing === null
      ? {}
      : {
          letterSpacing: assertBoundedFinite(
            r.letterSpacing,
            `${field}.letterSpacing`,
            -MAX_TEXT_LETTER_SPACING,
            MAX_TEXT_LETTER_SPACING,
          ),
        }),
    ...(r.baselineShift === undefined || r.baselineShift === null
      ? {}
      : {
          baselineShift: assertBoundedFinite(
            r.baselineShift,
            `${field}.baselineShift`,
            -MAX_TEXT_BASELINE_SHIFT,
            MAX_TEXT_BASELINE_SHIFT,
          ),
        }),
    ...(decoration === undefined ? {} : { decoration }),
    ...(r.strokeColor === undefined
      ? {}
      : { strokeColor: r.strokeColor === null ? null : reconstructColor(r.strokeColor, `${field}.strokeColor`) }),
    ...(r.strokeWidth === undefined || r.strokeWidth === null
      ? {}
      : { strokeWidth: assertBoundedFinite(r.strokeWidth, `${field}.strokeWidth`, 0, MAX_TEXT_STROKE_WIDTH) }),
    ...(optionalBoolean(r.kerning, `${field}.kerning`) === undefined
      ? {}
      : { kerning: optionalBoolean(r.kerning, `${field}.kerning`) }),
  };
}

function reconstructTextContent(raw: unknown): TextContent {
  const content = assertRecord(raw, "content");
  if (!Array.isArray(content.paragraphs)) {
    throw new Error('Serialized field "content.paragraphs" is not an array.');
  }
  if (content.paragraphs.length === 0 || content.paragraphs.length > MAX_TEXT_PARAGRAPHS) {
    throw new Error(`Serialized field "content.paragraphs" must contain 1..${MAX_TEXT_PARAGRAPHS} entries.`);
  }

  let totalRuns = 0;
  let totalTextLength = 0;
  const paragraphs: TextParagraph[] = content.paragraphs.map((paragraphRaw, paragraphIndex) => {
    const field = `content.paragraphs[${paragraphIndex}]`;
    const paragraph = assertRecord(paragraphRaw, field);
    if (!Array.isArray(paragraph.runs) || paragraph.runs.length === 0) {
      throw new Error(`Serialized field "${field}.runs" must be a non-empty array.`);
    }
    totalRuns += paragraph.runs.length;
    if (totalRuns > MAX_TEXT_RUNS) {
      throw new Error(`Serialized text content exceeds the ${MAX_TEXT_RUNS}-run limit.`);
    }
    const runs: TextRun[] = paragraph.runs.map((runRaw, runIndex) => {
      const runField = `${field}.runs[${runIndex}]`;
      const run = assertRecord(runRaw, runField);
      const text = assertString(run.text, `${runField}.text`);
      totalTextLength += text.length;
      if (totalTextLength > MAX_TEXT_CONTENT_LENGTH) {
        throw new Error(`Serialized text content exceeds the ${MAX_TEXT_CONTENT_LENGTH}-character limit.`);
      }
      return { text, style: reconstructTextRunStyle(run.style, `${runField}.style`) };
    });
    const listRaw = paragraph.list === undefined || paragraph.list === null ? {} : assertRecord(paragraph.list, `${field}.list`);
    const kind = listRaw.kind ?? "none";
    if (kind !== "none" && kind !== "bulleted" && kind !== "numbered") {
      throw new Error(`Serialized field "${field}.list.kind" is invalid.`);
    }
    const list: TextParagraphList = {
      kind,
      level: listRaw.level === undefined || listRaw.level === null
        ? 0
        : assertBoundedFinite(listRaw.level, `${field}.list.level`, 0, MAX_TEXT_LIST_LEVEL),
    };
    if (!Number.isInteger(list.level)) {
      throw new Error(`Serialized field "${field}.list.level" is not an integer.`);
    }
    return {
      runs,
      spacingBefore: paragraph.spacingBefore === undefined || paragraph.spacingBefore === null
        ? 0
        : assertBoundedFinite(paragraph.spacingBefore, `${field}.spacingBefore`, 0, MAX_TEXT_PARAGRAPH_SPACING),
      spacingAfter: paragraph.spacingAfter === undefined || paragraph.spacingAfter === null
        ? 0
        : assertBoundedFinite(paragraph.spacingAfter, `${field}.spacingAfter`, 0, MAX_TEXT_PARAGRAPH_SPACING),
      list,
    };
  });
  return { paragraphs };
}

function reconstructTextFramePadding(raw: unknown): TextFramePadding {
  const padding = assertRecord(raw, "frame.padding");
  return {
    top: assertBoundedFinite(padding.top, "frame.padding.top", 0, MAX_TEXT_FRAME_PADDING),
    right: assertBoundedFinite(padding.right, "frame.padding.right", 0, MAX_TEXT_FRAME_PADDING),
    bottom: assertBoundedFinite(padding.bottom, "frame.padding.bottom", 0, MAX_TEXT_FRAME_PADDING),
    left: assertBoundedFinite(padding.left, "frame.padding.left", 0, MAX_TEXT_FRAME_PADDING),
  };
}

function reconstructTextFrame(raw: unknown): TextFrame {
  const frame = assertRecord(raw, "frame");
  const verticalAlign = frame.verticalAlign;
  if (verticalAlign !== "top" && verticalAlign !== "middle" && verticalAlign !== "bottom") {
    throw new Error('Serialized field "frame.verticalAlign" is invalid.');
  }
  const wrapMode = frame.wrapMode;
  if (wrapMode !== "wrap" && wrapMode !== "nowrap") {
    throw new Error('Serialized field "frame.wrapMode" is invalid.');
  }
  const sizingMode = frame.sizingMode;
  if (sizingMode !== "auto-height" && sizingMode !== "fixed") {
    throw new Error('Serialized field "frame.sizingMode" is invalid.');
  }
  const columns = assertRecord(frame.columns, "frame.columns");
  const count = assertBoundedFinite(columns.count, "frame.columns.count", 1, MAX_TEXT_COLUMNS);
  if (!Number.isInteger(count)) throw new Error('Serialized field "frame.columns.count" is not an integer.');
  const columnConfig: TextColumnConfig = {
    count,
    gap: assertBoundedFinite(columns.gap, "frame.columns.gap", 0, MAX_TEXT_COLUMN_GAP),
  };
  return {
    padding: reconstructTextFramePadding(frame.padding),
    verticalAlign,
    wrapMode,
    sizingMode,
    columns: columnConfig,
  };
}

/** Resource bounds for the M6 shape/drawing fields (crafted-save hardening). */
const MAX_DASH_SEGMENTS = 32;
const MAX_SHAPE_POINTS = 100_000;
const MAX_DRAWING_WIDTHS = 100_000;

/**
 * Reads an optional dash pattern (M6, format v6): an array of finite,
 * non-negative segment lengths, capped at {@link MAX_DASH_SEGMENTS}. Absent /
 * null / empty / all-zero → undefined (solid, the pre-v6 default). A malformed
 * entry is dropped leniently rather than thrown, so a partially-corrupt pattern
 * never blocks loading.
 */
function optDash(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const v of value) {
    if (out.length >= MAX_DASH_SEGMENTS) break;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.push(v);
  }
  if (out.length === 0 || out.every((n) => n === 0)) return undefined;
  return out;
}

/**
 * Reads an optional drop shadow (M6, format v6). null/undefined/malformed →
 * null (no shadow, the pre-v6 default). Offsets/blur are read as finite numbers
 * (blur clamped to ≥ 0); the color is a required EditorColor when a shadow
 * object is present.
 */
function optShadow(value: unknown, field: string): ShapeShadow | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return {
    offsetX: optFinite(r.offsetX, `${field}.offsetX`, 0),
    offsetY: optFinite(r.offsetY, `${field}.offsetY`, 0),
    blur: Math.max(0, optFinite(r.blur, `${field}.blur`, 0)),
    color: reconstructColor(r.color, `${field}.color`),
  };
}

/** A finite number, or undefined (so the geometry clamps supply their default). */
function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const ALL_BRUSH_KINDS: readonly BrushKind[] = ["pen", "marker", "highlighter", "pencil"];

/** Validates a brush kind (M6, format v6); unknown values fall back to "pen". */
function reconstructBrush(value: unknown): BrushKind {
  return ALL_BRUSH_KINDS.includes(value as BrushKind) ? (value as BrushKind) : "pen";
}

function reconstructStyle(raw: unknown, field: string): ObjectStyle {
  if (!raw || typeof raw !== "object") throw new Error(`Serialized "${field}" is missing.`);
  const r = raw as Record<string, unknown>;
  const dash = optDash(r.dash);
  const shadow = optShadow(r.shadow, `${field}.shadow`);
  return {
    fill: r.fill === null ? null : reconstructColor(r.fill, `${field}.fill`),
    stroke: r.stroke === null ? null : reconstructColor(r.stroke, `${field}.stroke`),
    strokeWidth: assertFinite(r.strokeWidth, `${field}.strokeWidth`),
    cornerRadius: assertFinite(r.cornerRadius, `${field}.cornerRadius`),
    ...(dash !== undefined ? { dash } : {}),
    ...(shadow !== null ? { shadow } : {}),
  };
}

function reconstructBase(raw: Record<string, unknown>): ReconstructedBase {
  const transform = raw.transform;
  if (!transform || typeof transform !== "object") {
    throw new Error("Serialized object is missing its transform.");
  }
  const t = transform as Record<string, unknown>;
  const bounds = raw.localBounds;
  if (!bounds || typeof bounds !== "object") {
    throw new Error("Serialized object is missing its localBounds.");
  }
  const b = bounds as Record<string, unknown>;
  const metadata = raw.metadata;
  return {
    id: assertSafeObjectId(raw.id, "id"),
    kind: assertString(raw.kind, "kind"),
    layerId: assertString(raw.layerId, "layerId"),
    name: assertString(raw.name, "name"),
    transform: {
      a: assertFinite(t.a, "transform.a"),
      b: assertFinite(t.b, "transform.b"),
      c: assertFinite(t.c, "transform.c"),
      d: assertFinite(t.d, "transform.d"),
      e: assertFinite(t.e, "transform.e"),
      f: assertFinite(t.f, "transform.f"),
    },
    localBounds: {
      x: assertFinite(b.x, "localBounds.x"),
      y: assertFinite(b.y, "localBounds.y"),
      width: assertFinite(b.width, "localBounds.width"),
      height: assertFinite(b.height, "localBounds.height"),
    },
    opacity: assertFinite(raw.opacity, "opacity"),
    visible: Boolean(raw.visible),
    locked: Boolean(raw.locked),
    metadata:
      metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {},
  };
}

/** Reconstructs a typed object from a serialized record, validating per kind. */
function reconstructObject(
  raw: Record<string, unknown>,
  registry?: ObjectTypeRegistry,
): EditorObject {
  const base = reconstructBase(raw);
  const kind = base.kind;

  switch (kind) {
    case "text": {
      const content = reconstructTextContent(raw.content);
      return {
        ...base,
        kind,
        // `content` is canonical from v4 onward. Rebuilding this compatibility
        // projection prevents a crafted save from presenting different strings to
        // the legacy renderer/export path and the normalized content consumer.
        text: textContentToPlainText(content),
        content,
        frame: reconstructTextFrame(raw.frame),
        fontSize: assertFinite(raw.fontSize, "fontSize"),
        fontFamily: assertString(raw.fontFamily, "fontFamily"),
        fontWeight: assertFinite(raw.fontWeight, "fontWeight"),
        color: reconstructColor(raw.color, "color"),
        align: (raw.align === "left" || raw.align === "center" || raw.align === "right"
          ? raw.align
          : "left") as "left" | "center" | "right",
        lineHeight: assertFinite(raw.lineHeight, "lineHeight"),
        letterSpacing: optFinite(raw.letterSpacing, "letterSpacing", 0),
        // `wordSpacing`/`paragraphSpacing` (M5) were serialized but never read
        // back, so a text object with either set lost it on every load — the
        // spacing silently reverted to 0 and the next save wrote the 0. Read
        // here beside `letterSpacing`, which is the same kind of field and was
        // the one that got wired.
        wordSpacing: optFinite(raw.wordSpacing, "wordSpacing", 0),
        paragraphSpacing: optFinite(raw.paragraphSpacing, "paragraphSpacing", 0),
        background: optColor(raw.background, "background"),
        sourceText: optSourceText(raw.sourceText),
      } as AnyEditorObject;
    }
    case "image":
    case "signature": {
      const src = assertImageSource(raw.src, "src");
      const dimensions = validateImageDimensions(
        assertFinite(raw.naturalWidth, "naturalWidth"),
        assertFinite(raw.naturalHeight, "naturalHeight"),
      );
      const crop = kind === "image"
        ? (() => {
            const stored = optBounds(raw.crop, "crop");
            if (!stored) return null;
            const sanitized = sanitizeCrop(stored, dimensions.width, dimensions.height);
            const full = sanitized.x === 0 && sanitized.y === 0 && sanitized.width === dimensions.width && sanitized.height === dimensions.height;
            return full ? null : sanitized;
          })()
        : null;
      return {
        ...base,
        kind,
        src,
        naturalWidth: dimensions.width,
        naturalHeight: dimensions.height,
        ...(kind === "signature"
          ? { signer: assertString(raw.signer, "signer") }
          : { alt: assertString(raw.alt, "alt"), crop }),
      } as AnyEditorObject;
    }
    case "shape":
    case "drawing": {
      // Points are capped so a crafted save can't supply an unbounded polyline
      // that hangs the renderer/exporter (same rationale as the string cap).
      const rawPoints = Array.isArray(raw.points) ? (raw.points as Array<Record<string, unknown>>) : [];
      const cap = kind === "shape" ? MAX_SHAPE_POINTS : MAX_DRAWING_WIDTHS;
      const points = rawPoints.slice(0, cap).map((p, i) => ({
        x: assertFinite(p.x, `points[${i}].x`),
        y: assertFinite(p.y, `points[${i}].y`),
      }));
      if (kind === "shape") {
        // The shape kind is validated against the canonical union (M6): an
        // unknown/absent value falls back to "rect" (the pre-M6 default) rather
        // than throwing, so a save from a newer plugin kind still loads.
        const shape: ShapeKind = ALL_SHAPE_KINDS.includes(raw.shape as ShapeKind)
          ? (raw.shape as ShapeKind)
          : "rect";
        return {
          ...base,
          kind,
          shape,
          style: reconstructStyle(raw.style, "style"),
          points,
          // Per-kind parameters are all clamped by the canonical geometry module
          // so an out-of-range save renders identically to a fresh object. Only
          // the fields present on disk are attached (optional, format v6).
          ...(raw.sides !== undefined ? { sides: clampSides(numOrUndef(raw.sides)) } : {}),
          ...(raw.starPoints !== undefined ? { starPoints: clampStarPoints(numOrUndef(raw.starPoints)) } : {}),
          ...(raw.innerRatio !== undefined ? { innerRatio: clampInnerRatio(numOrUndef(raw.innerRatio)) } : {}),
          ...(raw.headSize !== undefined
            ? { headSize: clampHeadSize(numOrUndef(raw.headSize), Number.MAX_SAFE_INTEGER) }
            : {}),
          ...(raw.headType !== undefined
            ? { headType: (raw.headType === "open" ? "open" : "triangle") as ArrowHeadType }
            : {}),
          ...(raw.tailPosition !== undefined ? { tailPosition: clampTailPosition(numOrUndef(raw.tailPosition)) } : {}),
          ...(raw.connectorKind !== undefined
            ? { connectorKind: (raw.connectorKind === "elbow" ? "elbow" : "straight") as ConnectorKind }
            : {}),
          ...(raw.startArrow !== undefined ? { startArrow: Boolean(raw.startArrow) } : {}),
          ...(raw.endArrow !== undefined ? { endArrow: Boolean(raw.endArrow) } : {}),
          ...(typeof raw.pathData === "string" && raw.pathData.length > 0
            ? { pathData: normalizePathData(raw.pathData.slice(0, MAX_STRING_LENGTH)).pathData }
            : {}),
        } as AnyEditorObject;
      }
      // drawing: optional brush/smoothing/widths (format v6). Widths are read as
      // finite non-negative numbers; a malformed entry is dropped leniently.
      const widths = Array.isArray(raw.widths)
        ? (raw.widths as unknown[])
            .slice(0, MAX_DRAWING_WIDTHS)
            .filter((w): w is number => typeof w === "number" && Number.isFinite(w) && w >= 0)
        : undefined;
      return {
        ...base,
        kind,
        points,
        style: reconstructStyle(raw.style, "style"),
        ...(raw.brush !== undefined ? { brush: reconstructBrush(raw.brush) } : {}),
        ...(raw.smoothing !== undefined ? { smoothing: Boolean(raw.smoothing) } : {}),
        ...(widths !== undefined && widths.length > 0 ? { widths } : {}),
      } as AnyEditorObject;
    }
    case "annotation":
      return {
        ...base,
        kind,
        text: assertString(raw.text, "text"),
        fontSize: assertFinite(raw.fontSize, "fontSize"),
        color: reconstructColor(raw.color, "color"),
        pointerTarget:
          raw.pointerTarget && typeof raw.pointerTarget === "object"
            ? {
                x: assertFinite((raw.pointerTarget as Record<string, unknown>).x, "pointerTarget.x"),
                y: assertFinite((raw.pointerTarget as Record<string, unknown>).y, "pointerTarget.y"),
              }
            : null,
        /*
         * The note panel (v7). `optColor` is deliberate: a v7 document that says
         * `background: null` means a transparent note and must stay transparent.
         * Documents written before v7 never reach here with the field missing —
         * migration 6→7 backfills them — so a missing field at this point is a
         * hand-edited or truncated payload, and null is the honest reading of it
         * rather than silently re-painting it yellow.
         */
        background: optColor(raw.background, "background"),
        border: optColor(raw.border, "border"),
        borderWidth: Math.max(0, optFinite(raw.borderWidth, "borderWidth", 0)),
        cornerRadius: Math.max(0, optFinite(raw.cornerRadius, "cornerRadius", 0)),
      } as AnyEditorObject;
    case "highlight":
      return {
        ...base,
        kind,
        color: reconstructColor(raw.color, "color"),
      } as AnyEditorObject;
    default: {
      // Plugin-defined kind: use the registry if available, else generic restore.
      const def = registry?.get(kind);
      if (def?.deserialize) {
        return def.deserialize(base, raw.data);
      }
      // Strip base.kind (EditorObjectKind) so the result is cleanly a
      // PluginEditorObject with the plugin's string kind, not a conflicted cast.
      const { kind: _baseKind, ...rest } = base;
      return { ...rest, kind, data: raw.data ?? null };
    }
  }
}

function reconstructLayer(raw: Record<string, unknown>): Layer {
  return {
    id: assertString(raw.id, "layer.id"),
    name: assertString(raw.name, "layer.name"),
    visible: Boolean(raw.visible),
    locked: Boolean(raw.locked),
    opacity: assertFinite(raw.opacity, "layer.opacity"),
    objectIds: Array.isArray(raw.objectIds)
      ? (raw.objectIds as unknown[]).map((id, i) => assertSafeObjectId(id, `objectIds[${i}]`))
      : [],
  };
}

function reconstructPage(raw: Record<string, unknown>, registry?: ObjectTypeRegistry): EditorPage {
  const layerStackRaw = raw.layerStack;
  if (!layerStackRaw || typeof layerStackRaw !== "object") {
    throw new Error("Serialized page is missing its layerStack.");
  }
  const layersRaw = (layerStackRaw as Record<string, unknown>).layers;
  if (!Array.isArray(layersRaw)) {
    throw new Error("Serialized page layerStack.layers is not an array.");
  }
  const objectsRaw = raw.objects;
  if (!objectsRaw || typeof objectsRaw !== "object") {
    throw new Error("Serialized page is missing its objects map.");
  }
  const layerStack: LayerStack = {
    layers: (layersRaw as Array<Record<string, unknown>>).map(reconstructLayer),
  };
  const objects = Object.create(null) as Record<string, EditorObject>;
  for (const [rawId, objRaw] of Object.entries(objectsRaw as Record<string, unknown>)) {
    const id = assertSafeObjectId(rawId, "objects key");
    if (objRaw && typeof objRaw === "object") {
      const object = reconstructObject(objRaw as Record<string, unknown>, registry);
      if (object.id !== id) throw new Error(`Serialized object key "${id}" does not match object.id.`);
      objects[id] = object;
    }
  }
  const objectIds = new Set(Object.keys(objects));
  for (const layer of layerStack.layers) {
    for (const objectId of layer.objectIds) {
      if (!objectIds.has(objectId)) throw new Error(`Layer references missing object "${objectId}".`);
    }
  }
  // v5: the page's pinned source-PDF page index. Lenient like `rotation`: only
  // a non-negative integer is meaningful (a fractional/negative/garbage value
  // restores as null = "no source page" rather than blocking the load).
  const sourcePageIndexRaw = raw.sourcePageIndex;
  const sourcePageIndex =
    typeof sourcePageIndexRaw === "number" &&
    Number.isInteger(sourcePageIndexRaw) &&
    sourcePageIndexRaw >= 0
      ? sourcePageIndexRaw
      : null;
  return {
    id: assertString(raw.id, "page.id"),
    width: assertFinite(raw.width, "page.width"),
    height: assertFinite(raw.height, "page.height"),
    rotation: ((raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270
      ? raw.rotation
      : 0) as 0 | 90 | 180 | 270),
    sourcePageIndex,
    background:
      raw.background && typeof raw.background === "object"
        ? (raw.background as EditorPage["background"])
        : { type: "white" },
    objects,
    layerStack,
  };
}

function reconstructSelection(raw: unknown): SelectionState {
  if (!raw || typeof raw !== "object") return { ids: [], primaryId: null };
  const r = raw as Record<string, unknown>;
  return {
    ids: Array.isArray(r.ids) ? (r.ids as unknown[]).map((id) => String(id)) : [],
    primaryId: typeof r.primaryId === "string" ? r.primaryId : null,
  };
}

export class SerializationService implements ISerializer {
  constructor(private readonly registry?: ObjectTypeRegistry) {}

  serialize(state: EditorState): SerializedEditorState {
    return {
      format: FORMAT_ID,
      version: EDITOR_FORMAT_VERSION,
      document: jsonClone(state.document),
      activePageId: state.activePageId,
      selection: jsonClone(state.selection),
    };
  }

  deserialize(data: unknown): EditorState {
    const parsed = envelopeSchema.parse(data);
    if (parsed.version > EDITOR_FORMAT_VERSION) {
      throw new Error(
        `Serialized version ${parsed.version} is newer than the supported version ${EDITOR_FORMAT_VERSION}.`,
      );
    }
    const migrated = migrate(parsed as unknown as SerializedEditorState);

    const docRaw = migrated.document as Record<string, unknown>;
    const pagesRaw = docRaw.pages;
    if (!Array.isArray(pagesRaw)) {
      throw new Error("Serialized document.pages is not an array.");
    }
    const pages = (pagesRaw as Array<Record<string, unknown>>).map((p) =>
      reconstructPage(p, this.registry),
    );
    const document: EditorDocument = {
      id: assertString(docRaw.id, "document.id"),
      version: EDITOR_FORMAT_VERSION,
      pages,
      metadata:
        docRaw.metadata && typeof docRaw.metadata === "object"
          ? (docRaw.metadata as Record<string, unknown>)
          : {},
    };
    // Legacy imported-text normalization. Saves written before the capability
    // model contain editable COPIES of original PDF text with white covers over
    // the original; loading them unchanged would reproduce the duplication
    // defect. Unchanged copies become readonly references, user-modified ones
    // are preserved as replacements. This happens on READ, which is why no
    // database migration is needed — the affected state lives in editor JSON.
    const normalized = normalizeImportedText(document);
    return {
      document: normalized.document,
      activePageId: migrated.activePageId,
      selection: reconstructSelection(migrated.selection),
    };
  }
}
