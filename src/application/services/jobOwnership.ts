import type { Job, JobOwnerType } from "@/src/domain/entities/Job";

/**
 * Who is asking. Resolved server-side, never read from a request body.
 *
 * An anonymous visitor is a real actor with a real, stable id (a cookie), not a
 * shared `"anon"` bucket. The distinction matters: with one shared owner id,
 * every unauthenticated visitor passes every ownership check, and the ownership
 * check becomes decoration. `ownerId` is therefore always specific.
 */
export interface JobActor {
  ownerType: JobOwnerType;
  ownerId: string;
  /** Present only when the caller is acting inside a workspace. */
  workspaceId?: string | null;
}

/** Thrown when an actor addresses a job that is not theirs. */
export class JobAuthorizationError extends Error {
  constructor(message = "You do not have access to this job.") {
    super(message);
    this.name = "JobAuthorizationError";
  }
}

/**
 * Whether `actor` owns `job`.
 *
 * Deliberately strict on three points:
 *
 *  - A job with no recorded owner (`system` jobs, and rows written before
 *    ownership existed) is owned by nobody and therefore addressable by nobody.
 *    Treating "no owner" as "anyone" would make the retention sweep's own jobs
 *    publicly readable.
 *  - `ownerType` must match as well as `ownerId`. Without that, an anonymous
 *    visitor whose cookie id happened to equal a user's cuid would inherit that
 *    user's jobs.
 *  - Workspace scope, when the job has one, must also match. A user can be a
 *    member of several workspaces, and a job started in one should not surface
 *    in another.
 */
export function actorOwnsJob(actor: JobActor, job: Job): boolean {
  if (!job.ownerType || !job.ownerId) return false;
  if (job.ownerType !== actor.ownerType) return false;
  if (job.ownerId !== actor.ownerId) return false;
  if (job.workspaceId && job.workspaceId !== (actor.workspaceId ?? null)) return false;
  return true;
}

/**
 * Ownership gate. Throws the same error for "not found" and "not yours" at the
 * call sites that need it, so a probing caller cannot use the difference between
 * 403 and 404 to learn which job ids exist.
 */
export function assertActorOwnsJob(actor: JobActor, job: Job): void {
  if (!actorOwnsJob(actor, job)) throw new JobAuthorizationError();
}
