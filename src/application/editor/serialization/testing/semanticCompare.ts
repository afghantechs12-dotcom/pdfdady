import type { EditorDocument, EditorState } from "@/src/domain/editor/document";

/**
 * A SEMANTIC comparator for editor documents, for the round-trip fidelity tests.
 *
 * Why this exists rather than `toEqual` or a snapshot: the tests it serves have to
 * be able to fail for the right reason. `expect(objects.length).toBe(8)` passes
 * while every object is a rectangle; a snapshot of the whole document fails on any
 * change at all, so it gets regenerated and stops meaning anything. What is needed
 * is "the same document, property for property, with float noise tolerated and
 * nothing else tolerated" — and a failure that names the property.
 *
 * WHAT IS DELIBERATELY COMPARED:
 *
 *  - every own property of every object, including the ones the type system makes
 *    optional (`crop`, `dash`, `shadow`, `brush`, `widths`, `background`, …). A
 *    property that vanished is a difference, not a default.
 *  - object IDS, as the keys of the object map and as the ids in the layer arrays.
 *  - LAYER ARRAY ORDER, which IS the z-order — so paint order is compared as data,
 *    never re-derived from object type or map iteration order.
 *  - PAGE ARRAY ORDER, each page's `sourcePageIndex`, size, rotation and background.
 *  - the selection and the active page, which are part of the saved envelope.
 *
 * WHAT IS IGNORED, and why each one is genuinely transient:
 *
 *  - `document.version`, the FORMAT version stamp. Deserialization stamps the
 *    current version by construction, so comparing it would assert that no
 *    migration ran — the opposite of what these tests want.
 *  - nothing else. Ignoring more is how a comparator stops detecting the defect it
 *    was written for.
 *
 * FLOAT TOLERANCE. Numbers compare within {@link DEFAULT_TOLERANCE}, because a
 * value that survives JSON as `0.30000000000000004` is the same coordinate and a
 * test that says otherwise is noise. The tolerance is ABSOLUTE and small: a
 * comparator loose enough to accept a genuinely moved object is worse than no
 * comparator, since it reports fidelity that is not there.
 */

/**
 * Absolute tolerance for numeric equality.
 *
 * 1e-9 accepts IEEE-754 round-trip noise on the magnitudes this model uses (page
 * points, 0..1 colors, 0..1 opacity) and rejects every difference a user could
 * see — a 1e-9 point is a ten-millionth of a pixel.
 */
export const DEFAULT_TOLERANCE = 1e-9;

/** The one path segment that is legitimately not preserved. */
const IGNORED_PATHS: ReadonlySet<string> = new Set(["document.version"]);

export interface CompareOptions {
  /** Absolute numeric tolerance. Defaults to {@link DEFAULT_TOLERANCE}. */
  tolerance?: number;
  /**
   * Extra paths to ignore, exact match against the dotted path.
   *
   * Every use of this in a test is a claim that the named property is transient,
   * and belongs next to a comment saying why. It exists for the cases where a test
   * deliberately changes one property and compares everything else.
   */
  ignore?: readonly string[];
}

/**
 * The differences between two documents, as readable paths.
 *
 * An empty array means semantically identical. Each entry names the path and both
 * values, so a failing assertion says which property moved rather than dumping two
 * multi-kilobyte documents side by side.
 */
export function diffDocuments(
  expected: EditorDocument,
  actual: EditorDocument,
  options: CompareOptions = {},
): string[] {
  const out: string[] = [];
  const ignore = new Set([...IGNORED_PATHS, ...(options.ignore ?? [])]);
  walk("document", expected, actual, {
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
    ignore,
    out,
  });
  return out;
}

/** The same comparison over a whole state, including selection and active page. */
export function diffStates(
  expected: EditorState,
  actual: EditorState,
  options: CompareOptions = {},
): string[] {
  const out: string[] = [];
  const ignore = new Set([...IGNORED_PATHS, ...(options.ignore ?? [])]);
  const context = { tolerance: options.tolerance ?? DEFAULT_TOLERANCE, ignore, out };
  walk("document", expected.document, actual.document, context);
  walk("activePageId", expected.activePageId, actual.activePageId, context);
  walk("selection", expected.selection, actual.selection, context);
  return out;
}

interface WalkContext {
  tolerance: number;
  ignore: Set<string>;
  out: string[];
}

/**
 * The structural walk.
 *
 * `undefined` and absent are treated as the same thing, because JSON cannot
 * express the difference: a field set to `undefined` disappears on serialize, and
 * insisting they differ would fail every round trip for a reason no user can
 * observe. `null` is NOT that — it is a value the model uses deliberately
 * (`background: null` is a transparent note, `crop: null` is an uncropped image),
 * so null vs absent IS reported.
 */
function walk(path: string, expected: unknown, actual: unknown, context: WalkContext): void {
  if (context.ignore.has(path)) return;

  if (expected === undefined && actual === undefined) return;
  if (expected === undefined || actual === undefined) {
    context.out.push(`${path}: ${describe(expected)} → ${describe(actual)}`);
    return;
  }

  if (typeof expected === "number" && typeof actual === "number") {
    // NaN is not a value this model should ever hold, but comparing it by
    // subtraction would silently pass, so it is compared identically instead.
    if (Number.isNaN(expected) || Number.isNaN(actual)) {
      if (!(Number.isNaN(expected) && Number.isNaN(actual))) {
        context.out.push(`${path}: ${describe(expected)} → ${describe(actual)}`);
      }
      return;
    }
    if (Math.abs(expected - actual) > context.tolerance) {
      context.out.push(`${path}: ${expected} → ${actual}`);
    }
    return;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      context.out.push(`${path}: ${describe(expected)} → ${describe(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      context.out.push(`${path}.length: ${expected.length} → ${actual.length}`);
    }
    // Compared BY INDEX on purpose: for `layers[].objectIds` and `document.pages`
    // the index is the meaning. A set comparison here would accept a reordered
    // z-stack, which is the exact mutation test T9 has to catch.
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) walk(`${path}[${i}]`, expected[i], actual[i], context);
    return;
  }

  const expectedIsObject = typeof expected === "object" && expected !== null;
  const actualIsObject = typeof actual === "object" && actual !== null;
  if (expectedIsObject && actualIsObject) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    // The UNION of keys: a property that only the actual document has is a
    // difference too (an invented default is as wrong as a dropped field).
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      walk(`${path}.${key}`, a[key], b[key], context);
    }
    return;
  }

  if (expected !== actual) {
    context.out.push(`${path}: ${describe(expected)} → ${describe(actual)}`);
  }
}

/** A short, safe rendering of a value for a failure message. */
function describe(value: unknown): string {
  if (value === undefined) return "<absent>";
  if (value === null) return "null";
  if (typeof value === "string") {
    // Bounded: object text and image data URLs both live in this model, and a
    // failure message is not a place to spill either.
    return value.length > 40 ? `"${value.slice(0, 40)}…"(${value.length})` : `"${value}"`;
  }
  if (typeof value === "object") {
    return Array.isArray(value) ? `array(${value.length})` : `object(${Object.keys(value).length})`;
  }
  return String(value);
}
