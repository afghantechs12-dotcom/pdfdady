/**
 * The canonical generated-filename policy.
 *
 * Three independent implementations used to compose output names, and the
 * recording shows what that produced: `probe-document-merged (1)-merged.pdf`.
 *
 *   - `personalizeFileName` in `hooks/usePdfProcessor.ts` — client tools
 *   - `${ctx.baseName}-<suffix>.pdf` at twelve sites in `lib/server/toolProcessing.ts`
 *   - `${fileName}-edited.pdf` in the editor's export
 *
 * None of them knew what the others had already appended, so a name accumulated
 * one suffix per pass through the product, and a browser's `(1)` collision marker
 * became part of the base of the next name.
 *
 * ONE MODEL, stated once: a filename is a BASE plus exactly one EXTENSION. The
 * extension is supplied by whoever knows the output format, never carried over
 * from the input, which is what makes `.pdf.pdf` unreachable rather than merely
 * unlikely.
 */

/** A filename split into the two things it actually is. */
export interface FileNameParts {
  base: string;
  /** Lowercase, no leading dot. `""` when the name had no extension. */
  ext: string;
}

/** The base used when the input has no usable name of its own. */
export const UNTITLED_BASE = "Untitled";

/** Longest base a generated name carries. Ten merged inputs must not name a file. */
const MAX_BASE_LENGTH = 80;

/** Path separators, shell/reserved punctuation, and C0 control characters. */
const UNSAFE = new RegExp("[/\\\\:*?\"<>|\\u0000-\\u001f\\u007f]", "g");

/**
 * A trailing browser collision marker: `report (1)`.
 *
 * Stripped before a suffix is appended, because the marker is the DOWNLOAD
 * FOLDER's bookkeeping about a name collision on one machine — it says nothing
 * about the document, and carrying it into the next output is how
 * `probe-document-merged (1)-merged.pdf` happened.
 */
const COLLISION_MARKER = /\s*\((\d{1,4})\)$/;

/**
 * Splits on the LAST dot, and only when what follows looks like an extension.
 *
 * `Q3.Report.pdf` gives base `Q3.Report`. `v1.2` gives base `v1.2` and no
 * extension: a numeric tail is a version, and treating it as an extension is how
 * a base loses a character on every pass.
 */
export function splitFileName(name: string): FileNameParts {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*)\.([A-Za-z][A-Za-z0-9]{0,7})$/);
  if (!match || match[1] === "") return { base: trimmed, ext: "" };
  return { base: match[1], ext: match[2].toLowerCase() };
}

/** Rejoins the parts. An empty extension yields a bare base, never a trailing dot. */
export function joinFileName(parts: FileNameParts): string {
  const base = parts.base === "" ? UNTITLED_BASE : parts.base;
  return parts.ext === "" ? base : `${base}.${parts.ext}`;
}

/**
 * Reduces an untrusted name to a safe display base: no path separators, no
 * control characters, no collision marker, bounded length.
 *
 * Returns `""` for a name with nothing usable in it, so the caller decides what
 * the fallback means rather than having `Untitled` forced on it here.
 */
export function sanitizeBase(raw: string): string {
  return raw
    .replace(UNSAFE, "")
    .replace(COLLISION_MARKER, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .trim();
}

/** The clean base of a source filename: extension dropped, marker dropped. */
export function baseNameOf(fileName: string | null | undefined): string {
  return sanitizeBase(splitFileName(fileName ?? "").base);
}

/**
 * Combines several input names into ONE readable base.
 *
 * Bounded on purpose: ten merged files would otherwise produce a name no
 * filesystem wants and no user can read. Two names join; more than two name the
 * first and count the rest, which stays deterministic for the same inputs.
 */
export function combinedBaseName(fileNames: readonly string[]): string {
  const bases = fileNames.map(baseNameOf).filter((b) => b !== "");
  if (bases.length === 0) return "";
  if (bases.length === 1) return bases[0];
  if (bases.length === 2) return sanitizeBase(`${bases[0]}-and-${bases[1]}`);
  return sanitizeBase(`${bases[0]}-and-${bases.length - 1}-more`);
}

/**
 * The canonical generated output name.
 *
 * `sources` is what the user put in, `suffix` is what the tool did to it, `ext` is
 * the format that came out. The suffix is appended AT MOST ONCE: a base that
 * already ends with it is left alone, so re-merging `contract-merged.pdf` yields
 * `contract-merged.pdf` rather than growing a second `-merged`.
 *
 * That de-duplication is deliberately not "deduplicate anywhere in the name":
 * `merged-report-compressed` re-compressed must not silently collapse to
 * something that no longer records what just happened to it.
 */
export function outputFileName(input: {
  /** Input filenames, in the order the user supplied them. */
  sources?: readonly (string | null | undefined)[];
  /** What the tool did, e.g. `merged`. Omit for a format conversion. */
  suffix?: string | null;
  /** The produced format's extension, without a dot. */
  ext: string;
  /** Base used when the sources name nothing. Defaults to `Untitled`. */
  fallbackBase?: string;
}): string {
  const sources = (input.sources ?? []).filter(
    (name): name is string => typeof name === "string" && name.trim() !== "",
  );
  const combined = combinedBaseName(sources);
  const fallback = sanitizeBase(input.fallbackBase ?? UNTITLED_BASE) || UNTITLED_BASE;
  let base = combined === "" ? fallback : combined;

  const suffix = input.suffix ? sanitizeBase(input.suffix) : "";
  if (suffix !== "" && !endsWithSuffix(base, suffix)) {
    base = sanitizeBase(`${base}-${suffix}`);
  }

  return joinFileName({ base, ext: input.ext.replace(/^\./, "").toLowerCase() });
}

/** Case-insensitive `-suffix` tail check, so `-Merged` counts as merged. */
function endsWithSuffix(base: string, suffix: string): boolean {
  return base.toLowerCase().endsWith(`-${suffix}`.toLowerCase());
}

/**
 * Resolves a name against names already in use, and ONLY when a caller has a real
 * uniqueness requirement.
 *
 * Centralized here so `(1)` appears for exactly one reason — a collision the
 * caller can see — rather than being sprinkled by whichever layer felt unsure.
 * Nothing in the tool pipeline calls this: Workspace documents are identified by
 * id, and two documents may legitimately share a name.
 */
export function withUniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const { base, ext } = splitFileName(name);
  const stem = sanitizeBase(base) || UNTITLED_BASE;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = joinFileName({ base: `${stem} (${n})`, ext });
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return joinFileName({ base: `${stem} (${Date.now()})`, ext });
}
