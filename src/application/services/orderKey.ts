/**
 * Fractional lexicographic ordering keys (à la Figma/Linear "fractional
 * indexing"). Keys are plain strings that sort correctly with a standard
 * string comparator, so reordering never requires rewriting sibling rows —
 * only the moved row's orderKey changes. This gives folders/projects a
 * keyboard-operable move-up/move-down alternative to drag-and-drop without
 * a rebalancing pass on every move.
 *
 * Alphabet is base36 (0-9a-z), digit-by-digit midpoint generation with
 * arbitrary-length growth when two adjacent keys are already tight.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;

function charIndex(ch: string): number {
  const index = ALPHABET.indexOf(ch);
  if (index === -1) throw new Error(`Invalid order-key character: ${ch}`);
  return index;
}

/**
 * Returns a key that sorts strictly between `lo` and `hi` (both optional —
 * omit `lo` for "before everything", omit `hi` for "after everything").
 */
export function generateOrderKeyBetween(lo: string | null, hi: string | null): string {
  const low = lo ?? "";
  const high = hi ?? "";
  if (low && high && low >= high) {
    throw new Error(`generateOrderKeyBetween requires lo < hi (got "${low}" >= "${high}")`);
  }

  let result = "";
  let i = 0;
  for (;;) {
    const loDigit = i < low.length ? charIndex(low[i]) : 0;
    const hiDigit = high && i < high.length ? charIndex(high[i]) : BASE;

    if (hiDigit - loDigit > 1) {
      const mid = Math.floor((loDigit + hiDigit) / 2);
      result += ALPHABET[mid];
      return result;
    }

    // Digits are adjacent (or equal at the low bound) — emit the low digit
    // and continue into the next position to find room to differentiate.
    result += ALPHABET[loDigit];
    i += 1;

    if (i > low.length && (!high || i >= high.length)) {
      // Both bounds are exhausted at this depth; append a mid-alphabet
      // digit so the generated key still sorts after `low`.
      result += ALPHABET[Math.floor(BASE / 2)];
      return result;
    }
  }
}

/** First key in an empty ordered list. */
export function firstOrderKey(): string {
  return generateOrderKeyBetween(null, null);
}
