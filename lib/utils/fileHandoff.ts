/**
 * One-shot, in-memory handoff of a File across a client-side navigation.
 * Used by the homepage hero uploader: the dropped PDF is stashed here, the
 * user picks a tool, and the tool page's upload hook consumes it instead of
 * asking the user to upload the same file again.
 *
 * Module-level state survives App Router client navigations (the JS context
 * is kept), and is naturally empty on a hard load — which is the correct
 * behavior, since a File can't be serialized anyway.
 */
let pending: File | null = null;

export function setHandoffFile(file: File): void {
  pending = file;
}

/** Returns the stashed file once, then clears it. */
export function takeHandoffFile(): File | null {
  const file = pending;
  pending = null;
  return file;
}
