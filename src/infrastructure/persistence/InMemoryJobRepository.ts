import type { Job, JobOwnerType, JobStatus } from "@/src/domain/entities/Job";
import {
  EXPIRABLE_STATUSES,
  isTransitionAllowed,
} from "@/src/domain/jobs/jobStateMachine";
import type {
  IJobRepository,
  JobCreateInput,
  JobTransitionOptions,
  JobTransitionPatch,
  JobUpdatePatch,
  JobWriteOptions,
} from "@/src/application/ports/repositories/JobRepository";

let counter = 0;

/**
 * Per-process entropy, mixed into every id below.
 *
 * The counter alone restarts at 1 in each process, and vitest runs test files in
 * parallel forks that share one machine-wide scratch root — so two forks both
 * mint `inmem-job-11`, and anything keyed on a job id (a work directory, a
 * storage prefix) silently collides between unrelated tests. That surfaced as an
 * integration test blaming its own cleanup for a directory a sibling file had
 * just created: a real-looking leak report, a different test each run, and
 * nothing actually wrong with the cleanup.
 *
 * Ids are supposed to identify one job. Two repositories handing out the same
 * one is the defect, so the entropy goes here rather than in the assertion that
 * happened to trip over it.
 */
const processTag = Math.random().toString(36).slice(2, 8);

function uid(): string {
  counter += 1;
  return `inmem-job-${processTag}-${counter}`;
}

/**
 * In-memory JobRepository — used by tests and as a zero-dependency fallback.
 * Implements the same interface as the Prisma adapter, so the queue/worker
 * cannot tell them apart.
 */
export class InMemoryJobRepository implements IJobRepository {
  private readonly jobs = new Map<string, Job>();

  async create(input: JobCreateInput): Promise<Job> {
    const now = new Date();
    const status = input.status ?? "queued";
    const job: Job = {
      id: uid(),
      type: input.type,
      status,
      payload: input.payload,
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      ownerType: input.ownerType ?? null,
      ownerId: input.ownerId ?? null,
      workspaceId: input.workspaceId ?? null,
      toolSlug: input.toolSlug ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      progressStage: input.progressStage ?? null,
      errorCategory: null,
      safeErrorMessage: null,
      // Created-as-queued (the legacy path) is queued at creation time; a job
      // created in `created` has not been offered to the queue yet.
      queuedAt: status === "queued" ? now : null,
      cancelRequestedAt: null,
      expiresAt: input.expiresAt ?? null,
      inputBytes: input.inputBytes ?? null,
      outputBytes: null,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async get(id: string): Promise<Job | null> {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  async update(
    id: string,
    patch: JobUpdatePatch,
    opts: JobWriteOptions = {},
  ): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Job ${id} not found`);
    // See the port: a write from a worker whose attempt has been recovered must
    // not land, not even on `updatedAt`.
    if (opts.expectAttempts !== undefined && j.attempts !== opts.expectAttempts) {
      return null;
    }
    const updated: Job = { ...j, ...patch, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  async transition(
    id: string,
    to: JobStatus,
    patch: JobTransitionPatch = {},
    opts: JobTransitionOptions = {},
  ): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (!isTransitionAllowed(j.status, to, opts)) return null;
    if (opts.expectAttempts !== undefined && j.attempts !== opts.expectAttempts) {
      return null;
    }
    // Single-threaded JS: reading and writing without yielding is already the
    // compare-and-swap the Prisma adapter has to spell out explicitly.
    const updated: Job = { ...j, ...patch, status: to, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  async listByStatus(status: JobStatus, limit = 100): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === status)
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  /** Stale `running` jobs, oldest lease first. See the port for why `updatedAt`. */
  async listStaleRunning(before: Date, limit = 25): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === "running" && j.updatedAt.getTime() <= before.getTime())
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  async findByIdempotencyKey(
    ownerType: JobOwnerType,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<Job | null> {
    const found = [...this.jobs.values()].find(
      (j) =>
        j.idempotencyKey === idempotencyKey &&
        j.ownerType === ownerType &&
        j.ownerId === ownerId,
    );
    return found ? { ...found } : null;
  }

  async listExpirable(now: Date, limit = 100): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.expiresAt !== null &&
          j.expiresAt.getTime() <= now.getTime() &&
          EXPIRABLE_STATUSES.has(j.status),
      )
      .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
}
