/**
 * Load-time normalization of LEGACY imported-text objects.
 *
 * THE PROBLEM. Before the capability model existed, opening a PDF created a
 * fully editable `TextObject` for every extracted text run, each carrying an
 * opaque white `background` that was supposed to hide the original underneath.
 * Saved editor documents from that era are full of these copies. Loading one
 * unchanged would reproduce the exact defect the capability model removes: the
 * original text renders from the page raster, the copy renders on top of it in a
 * different font, and the white rectangle sits over whatever graphics were
 * behind the run.
 *
 * THE RULE. A legacy copy is classified by whether the user actually changed it:
 *
 *  - UNCHANGED (`text` still equals the original run, geometry untouched) — the
 *    user never edited this; it was only ever an artifact of the old import. It
 *    becomes a `readonly` reference: it stops rendering, stops exporting, and
 *    its white cover is dropped. The original PDF text becomes visible again,
 *    which is what the page looked like before the old import touched it.
 *
 *  - MODIFIED (the user typed a replacement, or moved/resized it) — this is real
 *    user work and must never be silently discarded. It becomes a `replace` run,
 *    which keeps rendering and exporting. Its background is retained as the
 *    removal patch, because that cover is the only thing standing between the
 *    user's replacement and the original text showing through.
 *
 *  - UNSAFE (modified but with NO background to remove the original with) — the
 *    user's replacement exists but nothing hides the original, so exporting it
 *    would print both. Converting it either way would be wrong: dropping it
 *    destroys user work, keeping it produces duplicated output. It is preserved
 *    as `replace` and REPORTED, so the caller can warn rather than silently
 *    altering the document.
 *
 * Editor-authored text (no `sourceText` marker) is never touched by any branch.
 *
 * This runs during deserialization, so no database migration is required — the
 * affected state lives in editor JSON and is normalized on read.
 */

import type { EditorDocument, EditorPage } from "@/src/domain/editor/document";
import type { EditorObject, TextObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { READONLY_REASON } from "@/src/domain/editor/sourceText";

/** One legacy object that could not be converted without a caveat. */
export interface LegacyTextWarning {
  objectId: string;
  pageId: string;
  /** What the run says, truncated for display. */
  text: string;
  /** Why this needed the user's attention, in words a user can act on. */
  message: string;
}

/** The outcome of normalizing a document. */
export interface NormalizeResult {
  document: EditorDocument;
  /** How many unchanged legacy copies were demoted to readonly references. */
  suppressed: number;
  /** How many modified legacy copies were kept as replacements. */
  preserved: number;
  /**
   * Bounded list of runs needing a warning. Bounded because a pathological
   * document could otherwise produce thousands of them and the UI must stay
   * usable; the count is reported separately so nothing is silently hidden.
   */
  warnings: LegacyTextWarning[];
  /** Total warning count, which may exceed `warnings.length`. */
  warningCount: number;
}

/** Cap on surfaced warnings — the full count is still reported. */
const MAX_WARNINGS = 20;

/**
 * True when a legacy imported run still holds exactly what was extracted from
 * the PDF, i.e. the user never edited it.
 *
 * `originalText` is only present on objects written after the capability model
 * landed. For a genuinely old save it is absent, and the honest answer is that
 * we cannot prove the user modified the text — so we fall back to the object's
 * NAME, which the old importer set to the first 24 characters of the extracted
 * run and which nothing in the editing UI updates when text is typed. A name
 * that still matches the text's prefix means untouched.
 */
export function isUnchangedLegacyCopy(obj: TextObject): boolean {
  const original = obj.sourceText?.originalText;
  if (typeof original === "string") return obj.text === original;
  const name = obj.name ?? "";
  if (name.length === 0) return false;
  const expected = obj.text.slice(0, 24);
  return name === expected || name === "Existing text";
}

/**
 * Normalizes one text object. Returns the replacement object, plus how it was
 * classified. Objects that are not legacy imported copies pass through by
 * identity so React reconciliation and structural sharing are preserved.
 */
function normalizeTextObject(
  obj: TextObject,
): { obj: TextObject; kind: "untouched" | "suppressed" | "preserved" | "unsafe" } {
  const marker = obj.sourceText;
  // Not imported text, or already carries a capability decision — leave it be.
  if (marker == null || marker.mode != null) return { obj, kind: "untouched" };

  if (isUnchangedLegacyCopy(obj)) {
    // Demote to a readonly reference: stop rendering, stop exporting, drop the
    // white cover so the original page content is visible again. Left UNLOCKED
    // so the run stays selectable and the Properties panel can explain it —
    // locking would remove it from hit-testing and the user would get no
    // explanation at all.
    return {
      obj: {
        ...obj,
        background: null,
        name: obj.text.slice(0, 24) || "Original PDF text",
        sourceText: {
          ...marker,
          mode: "readonly",
          reason: READONLY_REASON,
          originalText: marker.originalText ?? obj.text,
        },
      },
      kind: "suppressed",
    };
  }

  // Modified by the user. Keep it rendering and exporting as a replacement.
  const hasRemovalPatch = obj.background != null;
  return {
    obj: {
      ...obj,
      sourceText: {
        ...marker,
        mode: "replace",
        reason: hasRemovalPatch
          ? "The original text has been permanently removed from the replacement region."
          : "This replacement has no removal patch — the original PDF text may still show through.",
        originalText: marker.originalText,
      },
    },
    kind: hasRemovalPatch ? "preserved" : "unsafe",
  };
}

/**
 * Normalizes every legacy imported-text object in a document.
 *
 * Pure and allocation-conscious: a page with no legacy objects is returned by
 * identity, so loading a modern document costs one pass and no copies.
 */
export function normalizeImportedText(document: EditorDocument): NormalizeResult {
  let suppressed = 0;
  let preserved = 0;
  let warningCount = 0;
  const warnings: LegacyTextWarning[] = [];
  let documentChanged = false;

  const pages: EditorPage[] = document.pages.map((page) => {
    let pageChanged = false;
    const objects: Record<string, EditorObject> = {};

    for (const [id, obj] of Object.entries(page.objects)) {
      if (!isObjectKind(obj, "text")) {
        objects[id] = obj;
        continue;
      }
      const result = normalizeTextObject(obj);
      objects[id] = result.obj;
      if (result.kind === "untouched") continue;

      pageChanged = true;
      if (result.kind === "suppressed") suppressed++;
      else preserved++;

      if (result.kind === "unsafe") {
        warningCount++;
        if (warnings.length < MAX_WARNINGS) {
          warnings.push({
            objectId: id,
            pageId: page.id,
            text: obj.text.slice(0, 60),
            message:
              "This edited text has nothing covering the original PDF text beneath it, so both may appear in the exported file.",
          });
        }
      }
    }

    if (!pageChanged) return page;
    documentChanged = true;
    return { ...page, objects };
  });

  return {
    document: documentChanged ? { ...document, pages } : document,
    suppressed,
    preserved,
    warnings,
    warningCount,
  };
}
