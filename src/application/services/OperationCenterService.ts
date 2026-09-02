import { randomUUID } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import {
  COMMAND_LIMITS,
  boundOperationError,
  canTransitionOperation,
  isTerminalOperationStatus,
  operationProgress,
  sortOperations,
  trimOperationHistory,
  validateOperationProgress,
  type OperationDescriptor,
  type OperationStatus,
} from "@/src/domain/entities/CommandPalette";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export interface StartOperationInput {
  type: string;
  workspaceId: string;
  documentId?: string | null;
  label: string;
}

/**
 * Copies an operation for a caller.
 *
 * The dates are rebuilt, not carried over. A spread alone shares the `Date`
 * instances, and `Date` is mutable — a caller calling `setFullYear` on a
 * returned `createdAt` would be writing into stored state through what looks
 * like a read-only copy.
 */
function snapshot(operation: OperationDescriptor): OperationDescriptor {
  return {
    ...operation,
    createdAt: new Date(operation.createdAt.getTime()),
    updatedAt: new Date(operation.updatedAt.getTime()),
  };
}

/**
 * M7.14 operation center.
 *
 * Tracks long-running work so a user can see, cancel and retry it in one place.
 * State is in memory and per-process, deliberately: an operation describes work
 * *this server is doing now*, and a durable row would outlive the work it
 * describes and come back after a restart as an operation that is running
 * nowhere. Work that must survive a restart is owned by the M2 queue and its own
 * durable rows (M7.11 comparisons being the worked example); this center
 * observes and presents.
 *
 * Two rules are enforced rather than assumed:
 *
 * **Terminal states are final.** Every transition goes through
 * `canTransitionOperation`, so a duplicate or late delivery finds the state
 * already moved and is refused rather than replayed. An operation the user saw
 * fail cannot later report success.
 *
 * **Every read re-authorizes.** Listing and result access call
 * `WorkspaceService.get`, and an operation from another Workspace reads as
 * missing. An operation id must never confirm work the actor cannot see.
 */
export class OperationCenterService {
  private readonly operations = new Map<string, OperationDescriptor>();

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    /** Injected so tests can pin time without touching the system clock. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- lifecycle -----------------------------------------------------------

  /** Registers a new operation in `pending`. */
  async start(actor: ActorContext, input: StartOperationInput): Promise<OperationDescriptor> {
    // Write access: starting work is a mutation even though the row is ephemeral.
    const { workspace } = await this.workspaces.get(actor, input.workspaceId, true);

    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (label === "" || label.length > COMMAND_LIMITS.maxLabelLength) {
      throw new DomainError("An operation label is required.");
    }
    const type = typeof input.type === "string" ? input.type.trim() : "";
    if (type === "" || type.length > COMMAND_LIMITS.maxIdLength) {
      throw new DomainError("An operation type is required.");
    }

    const now = this.clock();
    const operation: OperationDescriptor = {
      id: `op-${randomUUID()}`,
      type,
      workspaceId: workspace.id,
      documentId: input.documentId ?? null,
      label,
      status: "pending",
      progress: 0,
      error: null,
      resultRef: null,
      createdAt: now,
      updatedAt: now,
    };

    this.operations.set(operation.id, operation);
    this.evict();
    this.logger.debug("Operation started", { operationId: operation.id, type });
    return snapshot(operation);
  }

  /**
   * Applies a transition, refusing anything the state machine disallows.
   *
   * Returns null when the operation is absent or the transition is illegal —
   * which is what makes a duplicate delivery safe rather than replayed. The
   * caller cannot tell a lost race from a missing operation, and does not need
   * to.
   */
  private transition(
    operationId: string,
    to: OperationStatus,
    patch: { progress?: number; error?: string | null; resultRef?: string | null } = {},
  ): OperationDescriptor | null {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    if (!canTransitionOperation(operation.status, to)) return null;

    const updated: OperationDescriptor = {
      ...operation,
      status: to,
      progress: operationProgress(to, patch.progress ?? operation.progress),
      error: patch.error === undefined ? operation.error : boundOperationError(patch.error),
      resultRef: patch.resultRef === undefined ? operation.resultRef : patch.resultRef,
      updatedAt: this.clock(),
    };
    this.operations.set(operationId, updated);
    return snapshot(updated);
  }

  /** Moves a pending operation into `running`. Null when already started. */
  markRunning(operationId: string): OperationDescriptor | null {
    return this.transition(operationId, "running", { progress: 0 });
  }

  /** Records progress. Refused once terminal, so a late worker cannot animate it. */
  reportProgress(operationId: string, progress: number): OperationDescriptor | null {
    const bounded = validateOperationProgress(progress);
    if (bounded === null) throw new DomainError("Progress must be between 0 and 100.");

    const operation = this.operations.get(operationId);
    if (!operation) return null;
    if (isTerminalOperationStatus(operation.status)) return null;

    const updated: OperationDescriptor = {
      ...operation,
      progress: operationProgress(operation.status, bounded),
      updatedAt: this.clock(),
    };
    this.operations.set(operationId, updated);
    return snapshot(updated);
  }

  /** Completes an operation, optionally attaching a result reference. */
  complete(operationId: string, resultRef: string | null = null): OperationDescriptor | null {
    return this.transition(operationId, "completed", { progress: 100, resultRef });
  }

  /** Fails an operation with a bounded reason. */
  fail(operationId: string, reason: string): OperationDescriptor | null {
    return this.transition(operationId, "failed", {
      error: boundOperationError(reason) ?? "The operation could not be completed.",
    });
  }

  /**
   * Cancels an operation.
   *
   * Requires write access for the same reason starting does: it changes what the
   * system is doing on the actor's behalf.
   */
  async cancel(
    actor: ActorContext,
    workspaceId: string,
    operationId: string,
  ): Promise<OperationDescriptor> {
    await this.workspaces.get(actor, workspaceId, true);
    const operation = this.requireScoped(workspaceId, operationId);

    if (isTerminalOperationStatus(operation.status)) {
      throw new DomainError("That operation has already finished.");
    }
    const cancelled = this.transition(operationId, "cancelled");
    if (!cancelled) throw new DomainError("That operation has already finished.");
    return cancelled;
  }

  /**
   * Retries a finished operation by creating a new one.
   *
   * Deliberately not a reset: rewriting the terminal state would erase the fact
   * that the work failed, and that history is what tells a user whether the
   * problem is recurring.
   */
  async retry(
    actor: ActorContext,
    workspaceId: string,
    operationId: string,
  ): Promise<OperationDescriptor> {
    const original = this.requireScoped(workspaceId, operationId);
    if (!isTerminalOperationStatus(original.status)) {
      throw new DomainError("That operation is still running.");
    }
    return this.start(actor, {
      type: original.type,
      workspaceId,
      documentId: original.documentId,
      label: original.label,
    });
  }

  // ---- reads ---------------------------------------------------------------

  private requireScoped(workspaceId: string, operationId: string): OperationDescriptor {
    const operation = this.operations.get(operationId);
    // Workspace-scoped: an operation from another Workspace reads as missing, so
    // an id cannot confirm work the actor is not entitled to see.
    if (!operation || operation.workspaceId !== workspaceId) {
      throw new NotFoundError("Operation not found.");
    }
    return operation;
  }

  /** A Workspace's operations, active first. */
  async list(actor: ActorContext, workspaceId: string): Promise<OperationDescriptor[]> {
    await this.workspaces.get(actor, workspaceId, false);
    const scoped = [...this.operations.values()].filter(
      (operation) => operation.workspaceId === workspaceId,
    );
    // Copied on the way out, so a caller mutating a result cannot reach stored
    // state.
    return sortOperations(scoped).map(snapshot);
  }

  /** One operation, re-authorized and Workspace-scoped. */
  async get(
    actor: ActorContext,
    workspaceId: string,
    operationId: string,
  ): Promise<OperationDescriptor> {
    await this.workspaces.get(actor, workspaceId, false);
    return snapshot(this.requireScoped(workspaceId, operationId));
  }

  /**
   * The result reference of a completed operation.
   *
   * Re-authorized on the way out and refused unless the operation actually
   * completed *and* carries a reference — a completed operation with nothing
   * attached is a state an interrupted worker produces, and handing it back would
   * open an empty result.
   */
  async getResultRef(
    actor: ActorContext,
    workspaceId: string,
    operationId: string,
  ): Promise<string> {
    await this.workspaces.get(actor, workspaceId, false);
    const operation = this.requireScoped(workspaceId, operationId);
    if (operation.status !== "completed" || operation.resultRef === null) {
      throw new DomainError("That operation has no result.");
    }
    return operation.resultRef;
  }

  /** Drops the oldest terminal operations once the history bound is exceeded. */
  private evict(): void {
    if (this.operations.size <= COMMAND_LIMITS.maxOperationHistory) return;
    const kept = trimOperationHistory([...this.operations.values()]);
    const keptIds = new Set(kept.map((operation) => operation.id));
    for (const id of [...this.operations.keys()]) {
      if (!keptIds.has(id)) this.operations.delete(id);
    }
  }

  /** Forgets a Workspace's operations. Used when a session ends. */
  forgetWorkspace(workspaceId: string): void {
    for (const [id, operation] of [...this.operations.entries()]) {
      if (operation.workspaceId === workspaceId) this.operations.delete(id);
    }
  }
}
