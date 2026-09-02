/**
 * Tool-job error category + user-facing message — shared by the server route
 * (which maps the category to an HTTP status) and the client (which shows the
 * message). Isomorphic: no server-only deps, so both the route and the client
 * component can import it. Centralizing the message keeps the server's JSON
 * error and the client's banner in sync instead of drifting in two switches.
 */

export type ToolJobErrorType =
  | "processing"
  | "missing-dependency"
  | "command"
  | "unexpected";

/**
 * The user-facing message for a tool-job failure category. `processing` carries
 * a dynamic message (the processor's specific error, e.g. "Password must be at
 * least 4 characters."); the others are fixed.
 */
export function toolErrorMessage(
  type: ToolJobErrorType,
  dynamicMessage?: string | null,
): string {
  switch (type) {
    case "missing-dependency":
      return "This tool is temporarily unavailable on the server. Please try again later.";
    case "processing":
      return dynamicMessage?.trim() || "Processing failed.";
    case "command":
      return "Processing failed. The file may be unsupported or damaged. Please try a different file.";
    default:
      return "Processing failed. Please try again.";
  }
}
