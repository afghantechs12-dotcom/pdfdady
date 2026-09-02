/**
 * User-facing history labels.
 *
 * WHY THIS EXISTS. The History panel and the Undo/Redo tooltips read their text
 * straight from `Command.label`, and those labels were written for engineers:
 * `EditorDocumentService.addObject` labels EVERY creation "Add object" — a
 * rectangle, an image, a signature and a drawn stroke all produce the same
 * word — and a drag produces a run of bare "Move" entries. The recording showed
 * the result: an unreadable stream of `Move / Move / Move / Add object`.
 *
 * The fix is presentational and deliberately narrow. Undo SEMANTICS are
 * untouched: this module maps a label (plus the object kind it acted on, when
 * known) to the phrase a person would use. No command is merged, split,
 * reordered or relabelled in the history itself, so what Undo does is exactly
 * what it did before — only what the UI CALLS it changes.
 *
 * Pure: no DOM, no services, no React.
 */

import type { EditorObject, ShapeKind } from "@/src/domain/editor/objects";
import { SHAPE_KIND_LABELS } from "@/src/domain/editor/shapeGeometry";

/** The object kinds history text can be specialised for. */
export type HistorySubjectKind = EditorObject["kind"];

/**
 * A noun for the thing an entry acted on. Shapes resolve to their specific kind
 * ("rectangle", "ellipse") because "shape" is exactly the vagueness being fixed.
 */
export function subjectNoun(kind: HistorySubjectKind, shape?: ShapeKind): string {
  if (kind === "shape") return shape ? SHAPE_KIND_LABELS[shape].toLowerCase() : "shape";
  switch (kind) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "drawing":
      return "drawing";
    case "highlight":
      return "highlight";
    case "annotation":
      return "comment";
    case "signature":
      return "signature";
    default:
      return "object";
  }
}

/**
 * Past-tense verb phrases for the engineering labels the command layer emits.
 *
 * Keys are the literal `Command.label` values in use. An unmapped label falls
 * through unchanged rather than being mangled into something wrong — a new
 * command showing its own label is a cosmetic gap; a mislabelled undo is a lie.
 *
 * `subject: false` marks phrases that already NAME what they acted on ("Edited
 * text"), so appending the noun would produce "Edited text text".
 */
const VERB_PAST: Readonly<Record<string, { phrase: string; subject: boolean }>> = {
  Move: { phrase: "Moved", subject: true },
  Resize: { phrase: "Resized", subject: true },
  Rotate: { phrase: "Rotated", subject: true },
  Delete: { phrase: "Deleted", subject: true },
  Erase: { phrase: "Erased", subject: true },
  Flip: { phrase: "Flipped", subject: true },
  Crop: { phrase: "Cropped", subject: true },
  "Crop image": { phrase: "Cropped image", subject: false },
  Align: { phrase: "Aligned", subject: true },
  Distribute: { phrase: "Distributed", subject: true },
  Group: { phrase: "Grouped", subject: true },
  Ungroup: { phrase: "Ungrouped", subject: true },
  Duplicate: { phrase: "Duplicated", subject: true },
  "Edit text": { phrase: "Edited text", subject: false },
  "Set text": { phrase: "Edited text", subject: false },
  "Bring forward": { phrase: "Brought forward", subject: true },
  "Send backward": { phrase: "Sent backward", subject: true },
  "Bring to front": { phrase: "Brought to front", subject: true },
  "Send to back": { phrase: "Sent to back", subject: true },
};

/**
 * The phrase to show for one history entry.
 *
 * `label` is the raw command label; `kind`/`shape` describe what it acted on when
 * the caller knows (the history panel knows only labels for older entries, so
 * both are optional and the result degrades to a subject-less phrase).
 */
export function historyPhrase(
  label: string,
  kind?: HistorySubjectKind,
  shape?: ShapeKind,
): string {
  const trimmed = label.trim();
  if (!trimmed) return "Edited document";

  // Creation: "Add object" is the one label that is actively unhelpful, because
  // every creation path in the service uses it.
  if (trimmed === "Add object") {
    return kind ? `Added ${subjectNoun(kind, shape)}` : "Added object";
  }

  // Labels the canvas already writes in product language ("Add rectangle") are
  // only normalised to past tense.
  const addMatch = /^Add (.+)$/.exec(trimmed);
  if (addMatch) return `Added ${addMatch[1].toLowerCase()}`;

  const verb = VERB_PAST[trimmed];
  if (verb) {
    return verb.subject && kind ? `${verb.phrase} ${subjectNoun(kind, shape)}` : verb.phrase;
  }

  // Page navigation reads as a place, not an operation.
  if (trimmed === "Switch page") return "Switched page";

  // Property edits: "Edit property" says nothing; the caller's own label
  // ("Fill", "Stroke width") is better, and most already pass one.
  if (trimmed === "Edit property") return kind ? `Edited ${subjectNoun(kind, shape)}` : "Edited property";

  return trimmed;
}

/**
 * Collapses a run of identical consecutive phrases into one row with a count,
 * so five nudges of the same image read as `Moved image ×5` instead of five
 * identical lines.
 *
 * Returns one entry per VISIBLE row, each carrying the history depth its row
 * corresponds to — the depth is what `jumpTo` needs, so grouping cannot break
 * navigation: clicking a grouped row jumps to the newest step in that run.
 */
export interface HistoryRow {
  phrase: string;
  count: number;
  /** Undo depth this row represents (the newest step in the run). */
  depth: number;
}

export function groupHistoryRows(phrases: readonly string[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const last = rows[rows.length - 1];
    if (last && last.phrase === phrase) {
      last.count += 1;
      last.depth = i + 1;
    } else {
      rows.push({ phrase, count: 1, depth: i + 1 });
    }
  }
  return rows;
}
