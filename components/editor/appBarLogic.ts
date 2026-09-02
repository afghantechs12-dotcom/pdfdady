/**
 * Presentation logic for the editor's app bar: the rename affordance's name rules.
 *
 * Pure and DOM-free so the rule that matters can be asserted directly — what a
 * rename may do to a filename that becomes an export filename.
 *
 * IT NO LONGER DECIDES WHAT THE SAVE PILL SAYS. It used to: `saveIndicator`
 * projected a save state of its own from the last completed EXPORT, while the
 * status bar projected one from the persistence coordinator's durability
 * watermarks. Two models, two answers, both rendered at once — which is how the
 * app bar came to read "Unsaved changes" beside a status bar reading "Saved on
 * this device". `deriveSaveStatus` is the one projection now, and both surfaces
 * render it (see `derivedStatus.ts` and `DocumentIdentity`).
 *
 * Its header also documented that "this application has NO client-side autosave",
 * which was true when written and is not now: the editor persists drafts to
 * IndexedDB through `DocumentPersistenceCoordinator`. An indicator reasoning from
 * exports alone could not see any of that, which is the deeper reason it is gone
 * rather than corrected.
 */

/**
 * The maximum length of a document name accepted by the rename affordance.
 *
 * Names become export filenames (`${name}-edited.pdf`). Long names risk hitting
 * filesystem path limits once a download directory is prepended, so the field
 * is bounded here rather than at download time where failure is opaque.
 */
export const MAX_DOCUMENT_NAME = 120;

/**
 * Sanitises a user-entered document name into one safe to use as a filename
 * stem.
 *
 * The editor's export path builds `${fileName}-edited.pdf` and hands it to a
 * download. A raw user string reaching that position is a real hazard, so this
 * is a whitelist-shaped cleanup rather than a cosmetic trim:
 *
 *  - path separators and traversal (`/`, `\`, `..`) are stripped, so a name can
 *    never redirect the download out of its directory;
 *  - characters Windows forbids in filenames (`<>:"|?*`) and control characters
 *    are removed, since a download whose name the OS rejects fails silently;
 *  - a leading dot is dropped (a hidden file is never what rename meant);
 *  - a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) is
 *    suffixed rather than rejected, because those names are legitimate prose
 *    ("Aux") and silently failing to save would be worse than a slight rename;
 *  - whitespace collapses, and the result is length-bounded.
 *
 * Returns `null` when nothing usable survives, which the caller must treat as
 * "keep the existing name" rather than as an empty title.
 */
export function sanitizeDocumentName(raw: string): string | null {
  const stripped = raw
    // Control characters: unprintable in a title and hostile in a filename.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Path separators and anything the platform forbids in a name.
    .replace(/[/\\<>:"|?*]/g, " ")
    // Traversal segments, removed AFTER separators become spaces.
    //
    // Order matters here, and getting it wrong is the bug this line exists for:
    // stripping only a LEADING `.` left "../../etc/passwd" as ".. etc passwd",
    // because the separators had already become spaces and pushed the dots into
    // the middle of the string. Any whitespace-delimited run of pure dots is
    // meaningless in a document title, so all of them go.
    .replace(/(^|\s)\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot would still make a hidden file.
    .replace(/^\.+/, "")
    .trim();

  if (stripped === "") return null;

  const bounded = stripped.slice(0, MAX_DOCUMENT_NAME).trim();
  if (bounded === "") return null;

  // A trailing dot or space is legal in the string but silently dropped by
  // Windows, which would make the saved name differ from the shown name.
  const trimmedTail = bounded.replace(/[. ]+$/, "");
  if (trimmedTail === "") return null;

  if (RESERVED_DEVICE_NAMES.test(trimmedTail)) return `${trimmedTail}-doc`;
  return trimmedTail;
}

/** Windows reserved device names, matched on the stem before any extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Whether a rename should be committed.
 *
 * A rename to the same value is not a change, and an unusable name is not a
 * rename — both return false so the caller can close the editor without
 * touching document state or pushing a no-op onto the undo stack.
 */
export function shouldCommitRename(current: string, next: string): boolean {
  const cleaned = sanitizeDocumentName(next);
  return cleaned !== null && cleaned !== current;
}
