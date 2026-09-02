/**
 * M7.14 command palette and operation center.
 *
 * Two things live here because they share one rule: **a descriptor is not a
 * permission**. A command's `enabled` flag and an operation's visible controls
 * decide what the UI *offers*; the service re-authorizes at execution time
 * regardless. A palette entry is a suggestion, and a suggestion that could
 * execute on its own authority would be a way to invoke anything by knowing its
 * id.
 *
 * Search is local and deterministic — a subsequence match with a transparent
 * score. Deliberately not a model call: a palette that sometimes returns
 * different results for the same keystrokes is one users stop trusting, and it
 * would put a network round-trip in front of every keystroke.
 */

export const COMMAND_LIMITS = {
  /** Longest accepted command id. */
  maxIdLength: 128,
  /** Longest accepted label or keyword. */
  maxLabelLength: 120,
  /** Most keywords one command may carry. */
  maxKeywords: 12,
  /** Most commands returned from one search. */
  maxResults: 50,
  /** Longest accepted search query. */
  maxQueryLength: 200,
  /** Most operations retained in the center's history. */
  maxOperationHistory: 100,
  /** Longest accepted operation error, in code points. */
  maxErrorLength: 500,
} as const;

// ---- commands ---------------------------------------------------------------

export const COMMAND_CATEGORIES = [
  "document",
  "edit",
  "view",
  "navigation",
  "collaboration",
  "workspace",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export function isCommandCategory(value: unknown): value is CommandCategory {
  return typeof value === "string" && (COMMAND_CATEGORIES as readonly string[]).includes(value);
}

/**
 * What a command needs before it can run.
 *
 * Requirements are declared rather than checked inline so the palette can grey
 * out a command *and say why* instead of offering it and failing.
 */
export interface CommandRequirements {
  /** Needs a document open in the active pane. */
  document?: boolean;
  /** Needs a text or object selection. */
  selection?: boolean;
  /** Needs write access to the Workspace. */
  write?: boolean;
  /** Needs more than one pane. */
  split?: boolean;
}

export interface CommandDescriptor {
  id: string;
  label: string;
  /** Alternative words a user might search by. */
  keywords: string[];
  category: CommandCategory;
  /** Display form of the shortcut, e.g. "Ctrl+K". Never parsed. */
  shortcut?: string | null;
  requirements?: CommandRequirements;
}

/** The context a command is evaluated against. */
export interface CommandContext {
  hasDocument: boolean;
  hasSelection: boolean;
  canWrite: boolean;
  isSplit: boolean;
  /** The pane a command would target. */
  activePane: string;
  /** The document a command would target, when there is one. */
  activeDocumentId: string | null;
}

export interface EvaluatedCommand extends CommandDescriptor {
  enabled: boolean;
  /** Why it is unavailable. Null when enabled. */
  disabledReason: string | null;
}

/**
 * Decides whether a command may be offered, and says why when it may not.
 *
 * The reason is part of the contract: a command that is simply greyed out reads
 * as broken, while one that explains itself tells the user what to do first.
 */
export function evaluateCommand(
  command: CommandDescriptor,
  context: CommandContext,
): EvaluatedCommand {
  const requirements = command.requirements ?? {};

  if (requirements.document === true && !context.hasDocument) {
    return { ...command, enabled: false, disabledReason: "Open a document first." };
  }
  if (requirements.selection === true && !context.hasSelection) {
    return { ...command, enabled: false, disabledReason: "Select something first." };
  }
  if (requirements.write === true && !context.canWrite) {
    return {
      ...command,
      enabled: false,
      disabledReason: "You do not have permission to do that.",
    };
  }
  if (requirements.split === true && !context.isSplit) {
    return { ...command, enabled: false, disabledReason: "Open split view first." };
  }
  return { ...command, enabled: true, disabledReason: null };
}

/** Whether a descriptor is well-formed enough to register. */
export function isValidCommand(command: unknown): command is CommandDescriptor {
  if (command === null || typeof command !== "object") return false;
  const c = command as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.trim() === "" || c.id.length > COMMAND_LIMITS.maxIdLength) {
    return false;
  }
  if (
    typeof c.label !== "string" ||
    c.label.trim() === "" ||
    c.label.length > COMMAND_LIMITS.maxLabelLength
  ) {
    return false;
  }
  if (!isCommandCategory(c.category)) return false;
  if (!Array.isArray(c.keywords) || c.keywords.length > COMMAND_LIMITS.maxKeywords) return false;
  return c.keywords.every(
    (keyword) => typeof keyword === "string" && keyword.length <= COMMAND_LIMITS.maxLabelLength,
  );
}

/**
 * Scores a command against a query, or returns null when it does not match.
 *
 * Ranking, best first: an exact label match, a label prefix, a word-boundary
 * prefix inside the label, a keyword match, then a subsequence anywhere. The
 * order matters more than the numbers — a user typing "sav" expects "Save"
 * before "Split view and save layout", and a flat substring match would not
 * deliver that.
 */
export function scoreCommand(command: CommandDescriptor, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;

  const label = command.label.toLowerCase();
  if (label === q) return 1000;
  if (label.startsWith(q)) return 900 - label.length;

  const words = label.split(/\s+/u);
  if (words.some((word) => word.startsWith(q))) return 800 - label.length;

  if (command.keywords.some((keyword) => keyword.toLowerCase().startsWith(q))) {
    return 700 - label.length;
  }
  if (label.includes(q)) return 600 - label.length;
  if (command.keywords.some((keyword) => keyword.toLowerCase().includes(q))) {
    return 500 - label.length;
  }
  // Subsequence: "sp" matches "Split Pane". Last resort, so it never outranks a
  // real prefix hit.
  if (isSubsequence(q, label)) return 400 - label.length;
  return null;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Searches the command set.
 *
 * Disabled commands are included rather than filtered out: hiding a command a
 * user knows exists reads as the feature having been removed, whereas showing it
 * greyed out with a reason tells them what to do first. Callers that genuinely
 * want only runnable commands filter on `enabled`.
 */
export function searchCommands(
  commands: readonly CommandDescriptor[],
  query: string,
  context: CommandContext,
): EvaluatedCommand[] {
  if (query.length > COMMAND_LIMITS.maxQueryLength) return [];

  const scored: Array<{ command: CommandDescriptor; score: number }> = [];
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score === null) continue;
    scored.push({ command, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .slice(0, COMMAND_LIMITS.maxResults)
    .map((entry) => evaluateCommand(entry.command, context));
}

/** Groups results by category, preserving rank within each group. */
export function groupByCategory(
  commands: readonly EvaluatedCommand[],
): Array<{ category: CommandCategory; commands: EvaluatedCommand[] }> {
  const groups = new Map<CommandCategory, EvaluatedCommand[]>();
  for (const command of commands) {
    const existing = groups.get(command.category);
    if (existing) existing.push(command);
    else groups.set(command.category, [command]);
  }
  return [...groups.entries()].map(([category, list]) => ({ category, commands: list }));
}

/**
 * Moves the highlighted index, skipping nothing.
 *
 * Wraps at both ends, and disabled entries remain selectable so a keyboard user
 * can read the reason a command is unavailable rather than having the cursor
 * skip silently past it.
 */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

// ---- operations -------------------------------------------------------------

export const OPERATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Permitted operation transitions.
 *
 * The same shape M7.11 uses for comparisons, and for the same reason: terminal
 * states have no outgoing edges, so a late worker cannot resurrect an operation
 * the user already saw finish.
 */
const OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  pending: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export interface OperationDescriptor {
  id: string;
  /** What kind of work this is, e.g. "comparison", "export", "reindex". */
  type: string;
  workspaceId: string;
  documentId: string | null;
  label: string;
  status: OperationStatus;
  /** 0..100, always consistent with status. */
  progress: number;
  error: string | null;
  /** Set when the operation produced something the user may open. */
  resultRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Progress implied by a status, so a client never renders "completed, 60%". */
export function operationProgress(status: OperationStatus, reported: number): number {
  if (status === "completed") return 100;
  if (status === "pending") return 0;
  if (!Number.isFinite(reported)) return 0;
  return Math.min(100, Math.max(0, Math.round(reported)));
}

/** Validates a progress report. */
export function validateOperationProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

/** Bounds an operation error for storage and display. */
export function boundOperationError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/\s+/gu, " ").trim();
  if (message === "") return null;
  const characters = [...message];
  return characters.length <= COMMAND_LIMITS.maxErrorLength
    ? message
    : characters.slice(0, COMMAND_LIMITS.maxErrorLength).join("");
}

export function canCancelOperation(operation: { status: OperationStatus }): boolean {
  return !isTerminalOperationStatus(operation.status);
}

export function canRetryOperation(operation: { status: OperationStatus }): boolean {
  return operation.status === "failed" || operation.status === "cancelled";
}

/**
 * Whether a result may be offered.
 *
 * Both a completed status *and* an actual reference, for the same reason M7.11
 * requires both: a completed operation with nothing attached is a state an
 * interrupted worker produces, and offering it would open an empty result.
 */
export function canOpenOperationResult(operation: {
  status: OperationStatus;
  resultRef: string | null;
}): boolean {
  return operation.status === "completed" && operation.resultRef !== null;
}

/** The accessible status text for an operation. */
export function operationStatusLabel(operation: {
  status: OperationStatus;
  progress: number;
  label: string;
}): string {
  switch (operation.status) {
    case "pending":
      return `${operation.label}: waiting to start`;
    case "running":
      return `${operation.label}: ${operation.progress}% complete`;
    case "completed":
      return `${operation.label}: completed`;
    case "failed":
      return `${operation.label}: failed`;
    case "cancelled":
      return `${operation.label}: cancelled`;
  }
}

/** Active operations first, then most recently updated. */
export function sortOperations<T extends { status: OperationStatus; updatedAt: Date }>(
  operations: readonly T[],
): T[] {
  return operations
    .slice()
    .sort(
      (a, b) =>
        Number(isTerminalOperationStatus(a.status)) - Number(isTerminalOperationStatus(b.status)) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
}

/** Bounds retained history, dropping the oldest terminal entries first. */
export function trimOperationHistory<T extends { status: OperationStatus; updatedAt: Date }>(
  operations: readonly T[],
): T[] {
  if (operations.length <= COMMAND_LIMITS.maxOperationHistory) return operations.slice();
  const sorted = sortOperations(operations);
  // Active work is never dropped to make room: it is the part the user is
  // waiting on.
  return sorted.slice(0, COMMAND_LIMITS.maxOperationHistory);
}
