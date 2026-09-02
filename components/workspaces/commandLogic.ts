import {
  COMMAND_CATEGORIES,
  COMMAND_LIMITS,
  canCancelOperation,
  canOpenOperationResult,
  canRetryOperation,
  isTerminalOperationStatus,
  moveSelection,
  operationStatusLabel,
  type CommandCategory,
  type CommandContext,
  type OperationStatus,
} from "@/src/domain/entities/CommandPalette";

/**
 * Presentation logic for the M7.14 command palette and operation center.
 *
 * Separated from the React components so the rules can be tested without a DOM:
 * how a query is normalized, where the arrow keys move, which controls an
 * operation offers, and what the live regions announce.
 *
 * Two rules run through all of it. A disabled command is *shown* with its reason
 * rather than hidden, and pressing Enter on one does nothing — the reason is the
 * useful part, and hiding the command would read as the feature having been
 * removed. And an operation is only ever described as completed with a result
 * when both are true; a completed status with nothing attached is a state an
 * interrupted worker produces, and offering a link would open an empty result.
 */

// ---- command presentation ---------------------------------------------------

export interface CommandView {
  id: string;
  label: string;
  category: CommandCategory;
  shortcut: string | null;
  enabled: boolean;
  disabledReason: string | null;
}

/**
 * Normalizes a typed query.
 *
 * Trimmed, case-folded and length-capped here rather than at the input, so a
 * paste of a very long string cannot reach the matcher at all.
 */
export function normalizeCommandQuery(raw: string): string {
  return raw.trim().slice(0, COMMAND_LIMITS.maxQueryLength).toLowerCase();
}

/** Whether a query is within the accepted bound. */
export function isQueryWithinBounds(raw: string): boolean {
  return raw.length <= COMMAND_LIMITS.maxQueryLength;
}

/**
 * Builds the context a command is evaluated against.
 *
 * `canWrite` comes from the server-resolved role, never from the client's own
 * belief about its permissions. It decides what is greyed out; the execution
 * route re-checks regardless.
 */
export function buildCommandContext(input: {
  activeDocumentId: string | null;
  hasSelection: boolean;
  canWrite: boolean;
  isSplit: boolean;
  activePane: "left" | "right";
}): CommandContext {
  return {
    hasDocument: input.activeDocumentId !== null,
    hasSelection: input.hasSelection,
    canWrite: input.canWrite,
    isSplit: input.isSplit,
    activePane: input.activePane,
    activeDocumentId: input.activeDocumentId,
  };
}

/** Human-readable category heading. */
export function categoryLabel(category: CommandCategory): string {
  switch (category) {
    case "document":
      return "Document";
    case "edit":
      return "Edit";
    case "view":
      return "View";
    case "navigation":
      return "Navigation";
    case "collaboration":
      return "Collaboration";
    case "workspace":
      return "Workspace";
  }
}

/**
 * Groups results into headed sections in a fixed category order.
 *
 * Fixed rather than by best-match, so the palette's shape does not rearrange
 * itself between keystrokes; rank still decides the order *within* a section,
 * and the flat selection order follows the rendered order exactly.
 */
export function groupCommandsForDisplay(
  commands: readonly CommandView[],
): Array<{ category: CommandCategory; label: string; commands: CommandView[] }> {
  const groups: Array<{ category: CommandCategory; label: string; commands: CommandView[] }> = [];
  for (const category of COMMAND_CATEGORIES) {
    const matching = commands.filter((command) => command.category === category);
    if (matching.length > 0) {
      groups.push({ category, label: categoryLabel(category), commands: matching });
    }
  }
  return groups;
}

/** The flat order the keyboard walks, matching the rendered order. */
export function flattenCommandGroups(
  groups: ReadonlyArray<{ commands: readonly CommandView[] }>,
): CommandView[] {
  return groups.flatMap((group) => [...group.commands]);
}

/** Display form of a shortcut, or null when the command has none. */
export function shortcutLabel(command: Pick<CommandView, "shortcut">): string | null {
  const shortcut = command.shortcut;
  if (typeof shortcut !== "string") return null;
  const trimmed = shortcut.trim();
  return trimmed === "" ? null : trimmed;
}

/** Whether Enter on this row should do anything. */
export function canExecuteCommand(command: Pick<CommandView, "enabled">): boolean {
  return command.enabled;
}

/**
 * The text explaining why a command is unavailable.
 *
 * An empty reason falls back to the generic text rather than through: `??` only
 * catches null, and an empty string would leave a greyed-out row with nothing to
 * announce, which reads as broken.
 */
export function disabledReasonText(command: Pick<CommandView, "enabled" | "disabledReason">):
  | string
  | null {
  if (command.enabled) return null;
  const reason = command.disabledReason?.trim();
  return reason === undefined || reason === ""
    ? "This command is not available right now."
    : reason;
}

export const COMMAND_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];

export type CommandKeyOutcome =
  | { kind: "move"; index: number }
  | { kind: "execute"; index: number }
  | { kind: "close" }
  | { kind: "ignore" };

/**
 * Resolves a keypress against the result list.
 *
 * Enter on a disabled row resolves to `ignore` rather than `execute`, so the
 * keyboard path cannot run something the pointer path greys out. Movement wraps
 * at both ends and does not skip disabled rows, so a keyboard user can reach one
 * and read its reason.
 */
export function resolveCommandKey(
  key: string,
  selectedIndex: number,
  commands: readonly CommandView[],
): CommandKeyOutcome {
  const count = commands.length;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: moveSelection(selectedIndex, 1, count) };
    case "ArrowUp":
      return { kind: "move", index: moveSelection(selectedIndex, -1, count) };
    case "Home":
      return count === 0 ? { kind: "ignore" } : { kind: "move", index: 0 };
    case "End":
      return count === 0 ? { kind: "ignore" } : { kind: "move", index: count - 1 };
    case "Enter": {
      const command = commands[selectedIndex];
      if (!command || !canExecuteCommand(command)) return { kind: "ignore" };
      return { kind: "execute", index: selectedIndex };
    }
    case "Escape":
      return { kind: "close" };
    default:
      return { kind: "ignore" };
  }
}

/**
 * Keeps the highlighted index valid after the result list changed.
 *
 * A new query resets to the first row rather than preserving a stale index: an
 * index that survived a list change points at whatever now happens to occupy
 * that position, which is how a user ends up running a command they never read.
 */
export function resetSelectionForResults(count: number): number {
  return count === 0 ? -1 : 0;
}

/** Clamps a selection into range, returning -1 for an empty list. */
export function boundSelection(index: number, count: number): number {
  if (count === 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, count - 1);
}

/** The `aria-activedescendant` target, or null when nothing is highlighted. */
export function activeDescendantId(
  baseId: string,
  selectedIndex: number,
  commands: readonly CommandView[],
): string | null {
  const command = commands[selectedIndex];
  return command ? `${baseId}-command-${command.id}` : null;
}

/** The DOM id of one rendered row. Must agree with `activeDescendantId`. */
export function commandOptionId(baseId: string, commandId: string): string {
  return `${baseId}-command-${commandId}`;
}

/** What the palette shows when a query matches nothing. */
export function emptyCommandStateText(query: string): string {
  return query.trim() === ""
    ? "Start typing to search commands."
    : `No commands match "${query.trim()}".`;
}

// ---- operation presentation -------------------------------------------------

export interface OperationView {
  id: string;
  type: string;
  documentId: string | null;
  label: string;
  status: OperationStatus;
  progress: number;
  error: string | null;
  hasResult: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Orders operations for display: active work first, then most recent.
 *
 * Active first because it is the part the user is waiting on, and a chronological
 * list buries a running job under everything that finished since it started.
 */
export function sortOperationsForDisplay(operations: readonly OperationView[]): OperationView[] {
  return operations
    .slice()
    .sort(
      (a, b) =>
        Number(isTerminalOperationStatus(a.status)) - Number(isTerminalOperationStatus(b.status)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}

/** Bounds what is rendered, so a long-lived session cannot grow the list forever. */
export function boundedOperationsForDisplay(
  operations: readonly OperationView[],
  limit: number = COMMAND_LIMITS.maxOperationHistory,
): OperationView[] {
  return sortOperationsForDisplay(operations).slice(0, Math.max(0, limit));
}

/** The accessible status text for one operation. */
export function operationLabel(operation: OperationView): string {
  return operationStatusLabel(operation);
}

/** Whether a determinate progress bar should be rendered. */
export function showsOperationProgress(operation: Pick<OperationView, "status">): boolean {
  return operation.status === "running";
}

/**
 * Whether a result may be offered.
 *
 * Requires the server's `hasResult` as well as the status. The server computes
 * it from the actual reference, so a completed operation an interrupted worker
 * left without a result does not get a link that opens nothing.
 */
export function canOpenResult(operation: Pick<OperationView, "status" | "hasResult">): boolean {
  return canOpenOperationResult({
    status: operation.status,
    resultRef: operation.hasResult ? "present" : null,
  });
}

/** Whether the cancel control applies. */
export function canCancel(operation: Pick<OperationView, "status">): boolean {
  return canCancelOperation(operation);
}

/** Whether the retry control applies. */
export function canRetry(operation: Pick<OperationView, "status">): boolean {
  return canRetryOperation(operation);
}

/**
 * What the operation center's live region announces.
 *
 * Progress is announced at completion and failure, not on every percentage
 * update: a live region that fires on each tick is unusable with a screen
 * reader, and the intermediate values are already on the progress bar.
 */
export function operationAnnouncement(operation: OperationView): string {
  switch (operation.status) {
    case "completed":
      return `${operation.label} completed.`;
    case "failed":
      return `${operation.label} failed. ${operation.error ?? ""}`.trim();
    case "cancelled":
      return `${operation.label} was cancelled.`;
    case "running":
      return `${operation.label} is running.`;
    case "pending":
      return `${operation.label} is waiting to start.`;
  }
}

/** What the panel shows with no operations. */
export const EMPTY_OPERATIONS_TEXT = "No recent operations.";

/**
 * Whether a fetched response should be applied.
 *
 * Requests are tagged with a monotonically increasing sequence and an older
 * reply is dropped. Without this a slow first request can land after a fast
 * second one and overwrite current state with stale data.
 */
export function isCurrentResponse(responseSequence: number, latestSequence: number): boolean {
  return responseSequence >= latestSequence;
}

/**
 * Merges a freshly fetched operation list over what is displayed.
 *
 * A terminal entry already on screen is never replaced by a non-terminal version
 * of itself. A duplicate or reordered delivery is the normal case with polling,
 * and letting one move a completed operation back to "running" would make the
 * panel claim work restarted when nothing did.
 */
export function mergeOperations(
  current: readonly OperationView[],
  incoming: readonly OperationView[],
): OperationView[] {
  const byId = new Map(current.map((operation) => [operation.id, operation]));
  for (const operation of incoming) {
    const existing = byId.get(operation.id);
    if (existing && isTerminalOperationStatus(existing.status)) {
      if (!isTerminalOperationStatus(operation.status)) continue;
    }
    byId.set(operation.id, operation);
  }
  return sortOperationsForDisplay([...byId.values()]);
}
