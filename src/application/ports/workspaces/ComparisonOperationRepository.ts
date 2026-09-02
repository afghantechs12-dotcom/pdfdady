import type {
  ComparisonOperation,
  ComparisonStatus,
  ComparisonType,
} from "@/src/domain/entities/DocumentStatistics";

export interface CreateComparisonOperationInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  leftVersionId: string;
  rightVersionId: string;
  type: ComparisonType;
  requestedById: string;
}

export interface ComparisonOperationListQuery {
  workspaceId: string;
  documentId: string;
  status?: ComparisonStatus;
  limit: number;
}

/**
 * Comparison operations.
 *
 * `transition` is the only way a status changes, and it is a compare-and-swap on
 * the *current status* rather than on a revision counter. That is deliberate: the
 * rule being enforced is "this transition is legal from this state", and a
 * revision check would permit an illegal transition that happened to arrive with
 * the right number. A duplicate worker delivery therefore finds the state already
 * moved and is refused, which is what makes redelivery idempotent.
 */
export interface ComparisonOperationRepository {
  create(input: CreateComparisonOperationInput): Promise<ComparisonOperation>;

  getById(workspaceId: string, comparisonId: string): Promise<ComparisonOperation | null>;

  /** Newest first, bounded by the domain listing cap. */
  list(query: ComparisonOperationListQuery): Promise<ComparisonOperation[]>;

  /**
   * Moves an operation from `expectedStatus` to `status`, atomically. Returns
   * null when the operation is absent or no longer in `expectedStatus` — a
   * caller must not be able to tell a lost race from a missing operation.
   */
  transition(
    workspaceId: string,
    comparisonId: string,
    expectedStatus: ComparisonStatus,
    status: ComparisonStatus,
    patch: {
      progress?: number;
      error?: string | null;
      resultId?: string | null;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<ComparisonOperation | null>;

  /**
   * Records progress without changing status. Refuses once terminal, so a slow
   * worker cannot animate a finished operation.
   */
  reportProgress(
    workspaceId: string,
    comparisonId: string,
    progress: number,
  ): Promise<ComparisonOperation | null>;

  /**
   * Marks that cancellation was requested. Separate from the status because
   * long work observes the request at its next checkpoint rather than being
   * interrupted mid-page.
   */
  requestCancellation(
    workspaceId: string,
    comparisonId: string,
    requestedAt: Date,
  ): Promise<ComparisonOperation | null>;

  /** How many operations for a document are not yet in a terminal state. */
  countActiveForDocument(workspaceId: string, documentId: string): Promise<number>;

  delete(workspaceId: string, comparisonId: string): Promise<boolean>;
}
