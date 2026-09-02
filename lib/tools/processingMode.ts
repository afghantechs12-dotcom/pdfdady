import type { ToolStatus } from "@/data/tools";

/**
 * The user-facing processing model.
 *
 * The launch brief's rule is that displayed privacy/processing claims must be
 * derived from the tool registry, never from marketing copy — so that a copy
 * edit can never make the site claim something the code does not do. This
 * module is that derivation, and it is the ONLY sanctioned way to describe
 * where a file is processed.
 *
 * The internal `ToolStatus` values (`functional-client`, `functional-server`)
 * are implementation detail and must not reach users: rendering a "SERVER"
 * badge, as the previous ToolCard did, tells a visitor nothing useful and leaks
 * how the thing is built. `ProcessingMode` is the public vocabulary.
 *
 * `workspace` has no `ToolStatus` counterpart because it is not a tool
 * property: it describes what happens when a user saves a result INTO their
 * Workspace, which is a separate, opt-in action.
 */
export type ProcessingMode = "browser" | "secure-cloud" | "workspace";

/** Availability, as distinct from processing location. */
export type ToolAvailability = "available" | "coming-later";

export interface ProcessingModeCopy {
  mode: ProcessingMode;
  /** Short label for a badge. */
  label: string;
  /** One-sentence explanation shown in a tooltip or under the upload zone. */
  description: string;
  /** Longer form for a tool landing page's privacy section. */
  detail: string;
}

/**
 * The exact wording used everywhere a processing mode is explained.
 *
 * Each string is deliberately conditional and behavioural. Note what is NOT
 * claimed: no "never uploaded" (false for cloud tools), no "nothing is stored"
 * (false for Workspace), no "100% secure", and no automatic-deletion promise
 * that no retention job actually implements. See
 * docs/launch-feature-evidence.md for the claim-by-claim justification.
 */
export const PROCESSING_MODE_COPY: Record<ProcessingMode, ProcessingModeCopy> = {
  browser: {
    mode: "browser",
    label: "Browser",
    description: "Runs in your browser — the file is not sent to our servers for this tool.",
    detail:
      "This tool does its work entirely in your browser using your device's own resources. The file you choose is not uploaded to our servers to perform this operation. Closing the tab discards it.",
  },
  "secure-cloud": {
    mode: "secure-cloud",
    label: "Secure cloud",
    description: "Uploaded over an encrypted connection and processed on our servers.",
    detail:
      "This tool needs server-side processing, so your file is uploaded over an encrypted connection (HTTPS), processed, and made available to download. It is removed from temporary processing storage once the job completes and you have retrieved the result.",
  },
  workspace: {
    mode: "workspace",
    label: "Workspace",
    description: "Saved to your Workspace and kept until you delete or archive it.",
    detail:
      "Files saved to your Workspace are stored so you can come back to them, open them in the editor, and restore earlier versions. They remain available until you delete or archive them.",
  },
};

/**
 * Maps an internal tool status to its public processing mode.
 *
 * Returns null for statuses that describe unavailable work: a tool that cannot
 * run has no processing location, and inventing one for it would imply it is
 * executable.
 */
export function processingModeForStatus(status: ToolStatus): ProcessingMode | null {
  switch (status) {
    case "functional-client":
      return "browser";
    case "functional-server":
      return "secure-cloud";
    case "planned":
    case "coming-soon-ai":
      return null;
  }
}

/** Whether a tool can actually be run by a user today. */
export function availabilityForStatus(status: ToolStatus): ToolAvailability {
  return status === "functional-client" || status === "functional-server"
    ? "available"
    : "coming-later";
}

/** True when the tool must not present an executable affordance. */
export function isComingLater(status: ToolStatus): boolean {
  return availabilityForStatus(status) === "coming-later";
}

/** Convenience: the copy block for a status, or null when not applicable. */
export function processingCopyForStatus(
  status: ToolStatus,
): ProcessingModeCopy | null {
  const mode = processingModeForStatus(status);
  return mode ? PROCESSING_MODE_COPY[mode] : null;
}

/**
 * Phrases that must never appear in user-facing copy, with the reason.
 *
 * Used by the guard test in lib/tools/processingMode.test.ts, which scans the
 * public surface. Keeping the list in source (rather than in the test) means
 * the prohibition is documented where an author writing copy will see it.
 */
export const FORBIDDEN_CLAIMS: { phrase: string; because: string }[] = [
  { phrase: "never uploaded", because: "false for the 14 secure-cloud tools" },
  { phrase: "nothing is stored", because: "false — Workspace storage is durable" },
  { phrase: "100% secure", because: "absolute security claim, unevidenced" },
  { phrase: "files deleted automatically", because: "no retention job implements this globally" },
  { phrase: "end-to-end encryption", because: "not implemented" },
  { phrase: "zero knowledge", because: "not implemented" },
  { phrase: "military-grade", because: "marketing term with no technical meaning" },
];
