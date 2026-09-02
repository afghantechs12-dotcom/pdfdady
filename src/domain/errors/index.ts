/**
 * Domain-level error hierarchy. Infrastructure and presentation layers throw
 * or translate these; they never leak framework-specific error types (Prisma,
 * HTTP, etc.) into the domain/application layers.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** A referenced entity does not exist. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The application is misconfigured (missing/invalid env, bad wiring). */
export class ConfigurationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** An operation was attempted behind a disabled feature flag. */
export class FeatureDisabledError extends DomainError {
  constructor(key: string) {
    super(`Feature "${key}" is not enabled.`);
    this.name = "FeatureDisabledError";
  }
}

/**
 * The internal category of a Workspace lookup failure.
 *
 * These exist so logs and tests can tell the four situations apart. The
 * user-visible outcome deliberately does NOT vary between them: see
 * `WorkspaceAccessError`.
 */
export type WorkspaceAccessCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ACCESS_DENIED"
  | "WORKSPACE_ID_INVALID";

/**
 * A Workspace could not be resolved for an actor.
 *
 * Extends `NotFoundError` on purpose. All three categories must present as the
 * same 404 "Workspace not found." to the caller — a distinct "you do not have
 * access" would turn the route into an existence oracle for Workspaces in
 * organizations the actor cannot see. The distinction lives in `code`, which is
 * for logs and tests, never for the response body.
 */
export class WorkspaceAccessError extends NotFoundError {
  constructor(
    readonly code: WorkspaceAccessCode,
    message = "Workspace not found.",
  ) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

/**
 * A write was attempted on a Workspace whose lifecycle state forbids writes.
 *
 * A `DomainError` rather than a `NotFoundError`: this is only ever raised for an
 * actor who already has read access, so the state is not a secret from them, and
 * "archived" is actionable where "not found" is a dead end. Maps to 409.
 */
export class WorkspaceLifecycleError extends DomainError {
  readonly code = "WORKSPACE_ARCHIVED" as const;
  constructor(state: string) {
    super(`This Workspace is ${state}. Restore it before making changes.`);
    this.name = "WorkspaceLifecycleError";
  }
}
