import { PDFArray, PDFRawStream, PDFDocument, decodePDFRawStream } from "pdf-lib";

/**
 * Reads back what an exported PDF actually DRAWS, for the export-fidelity tests.
 *
 * Why this exists: the export tests could only assert that `exportPdf` did not
 * throw and that the bytes started with `%PDF-`. Both were true throughout the
 * whole period in which a yellow sticky note exported as bare floating text —
 * the exporter drew no panel at all, and every test passed. "Did not throw" is
 * not a fidelity assertion; "the page's content stream sets this fill color and
 * paints a path with it" is.
 *
 * It reads the page's content stream, inflates it, and pulls out the three things
 * the fidelity tests need to name: the fill colors set, the stroke colors set,
 * and the text strings shown. That is a deliberately small slice of PDF — this is
 * not a PDF interpreter, and it does not track the graphics state stack. It is
 * enough to answer "is the yellow container in there, and is the text in there",
 * which is the question the regression is about.
 *
 * Reading the content stream rather than rasterizing is the right level HERE:
 * vitest runs in `environment: "node"` with no canvas, and pixel comparison is
 * what the browser probe and `scripts/export-fidelity-probe.mts` do. A unit test
 * that needs a headless Chrome to assert a fill color would not be run.
 */

/** A non-stroking or stroking color set in a content stream (device RGB). */
export interface ContentColor {
  r: number;
  g: number;
  b: number;
}

/** What one page of an exported PDF draws. */
export interface PdfPageContent {
  /** The inflated, concatenated content stream — for assertions this API misses. */
  operators: string;
  /** Colors set with `rg` (non-stroking fill), in stream order. */
  fills: ContentColor[];
  /** Colors set with `RG` (stroking), in stream order. */
  strokes: ContentColor[];
  /** Strings shown with `Tj`/`TJ`, decoded from both hex and literal form. */
  texts: string[];
  /** Path-painting operators used (`f`, `S`, `B`, `B*`, `f*`, `b`, …), in order. */
  paints: string[];
}

/**
 * True when `color` matches `expected` on every channel within `tolerance`.
 *
 * The tolerance exists because a channel makes a round trip through the model's
 * 0..1 float, pdf-lib's number formatter and back — not because "close enough"
 * is the standard. 0.01 is a quarter of a step of an 8-bit channel: it accepts
 * formatting, and rejects a different color.
 */
export function colorMatches(
  color: ContentColor,
  expected: ContentColor,
  tolerance = 0.01,
): boolean {
  return (
    Math.abs(color.r - expected.r) <= tolerance &&
    Math.abs(color.g - expected.g) <= tolerance &&
    Math.abs(color.b - expected.b) <= tolerance
  );
}

/** Reads one page's drawn content. */
export async function readPdfPageContent(
  bytes: Uint8Array,
  pageIndex = 0,
): Promise<PdfPageContent> {
  const pages = await readPdfPageContents(bytes);
  const page = pages[pageIndex];
  if (!page) throw new Error(`Exported PDF has no page ${pageIndex} (it has ${pages.length}).`);
  return page;
}

/** Reads every page's drawn content, in document order. */
export async function readPdfPageContents(bytes: Uint8Array): Promise<PdfPageContent[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    // A page's content may be one stream or an array of streams that concatenate
    // into one; pdf-lib produces the array form once anything is drawn onto a
    // copied source page, which is exactly the case the fidelity tests use.
    const parts =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => page.node.context.lookup(ref))
        : [contents];
    const text = parts
      .map((part) =>
        part instanceof PDFRawStream
          ? new TextDecoder("latin1").decode(decodePDFRawStream(part).decode())
          : "",
      )
      .join("\n");
    return parseContentStream(text);
  });
}

/**
 * Pulls colors, painted-path operators and shown text out of a content stream.
 *
 * Regex-based on purpose. A full lexer would be the right tool for interpreting
 * PDF; for "which colors were set and which strings were shown" it would be a
 * few hundred lines that can be wrong in more ways than the twenty below.
 */
function parseContentStream(stream: string): PdfPageContent {
  const number = String.raw`(-?[0-9]*\.?[0-9]+)`;
  const fills: ContentColor[] = [];
  const strokes: ContentColor[] = [];
  const paints: string[] = [];
  const texts: string[] = [];

  const rgb = new RegExp(`${number}\\s+${number}\\s+${number}\\s+(rg|RG)\\b`, "g");
  for (const match of stream.matchAll(rgb)) {
    const color = { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    (match[4] === "rg" ? fills : strokes).push(color);
  }

  // Path painting: the operator alone on its own token position. `B` fills AND
  // strokes, which is what a note panel with a border emits — asserting only on
  // `f` would miss it.
  for (const match of stream.matchAll(/(?:^|\s)(f\*|f|B\*|B|b\*|b|S|s)(?=\s|$)/g)) {
    paints.push(match[1]);
  }

  // Hex strings: `<48656C6C6F> Tj`. pdf-lib emits these for standard fonts.
  for (const match of stream.matchAll(/<([0-9A-Fa-f\s]*)>\s*(?:Tj|TJ)/g)) {
    texts.push(decodeHexString(match[1]));
  }
  // Literal strings: `(Hello) Tj`. Kept because it is the other legal form and a
  // test asserting on text must not silently see nothing if the writer changes.
  for (const match of stream.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|TJ)/g)) {
    texts.push(match[1].replace(/\\([\\()])/g, "$1"));
  }

  return { operators: stream, fills, strokes, texts, paints };
}

/** Decodes a PDF hex string, ignoring whitespace, as UTF-16BE-free latin1. */
function decodeHexString(hex: string): string {
  const digits = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < digits.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16));
  }
  return out;
}
