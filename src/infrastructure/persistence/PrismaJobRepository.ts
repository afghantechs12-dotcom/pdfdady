import { PrismaClient, Prisma } from "@prisma/client";
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

type JobRow = {
  id: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  ownerType: string | null;
  ownerId: string | null;
  workspaceId: string | null;
  toolSlug: string | null;
  idempotencyKey: string | null;
  progressStage: string | null;
  errorCategory: string | null;
  safeErrorMessage: string | null;
  queuedAt: Date | null;
  cancelRequestedAt: Date | null;
  expiresAt: Date | null;
  inputBytes: number | null;
  outputBytes: number | null;
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toDomain(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status as JobStatus,
    payload: safeParse(row.payload),
    result: row.result ? safeParse(row.result) : null,
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    ownerType: (row.ownerType as JobOwnerType | null) ?? null,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    toolSlug: row.toolSlug,
    idempotencyKey: row.idempotencyKey,
    progressStage: row.progressStage,
    errorCategory: row.errorCategory,
    safeErrorMessage: row.safeErrorMessage,
    queuedAt: row.queuedAt,
    cancelRequestedAt: row.cancelRequestedAt,
    expiresAt: row.expiresAt,
    inputBytes: row.inputBytes,
    outputBytes: row.outputBytes,
  };
}

/** Maps a patch onto Prisma update data, omitting keys the caller didn't set. */
function toUpdateData(patch: JobUpdatePatch): Prisma.JobUpdateInput {
  const data: Prisma.JobUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.result !== undefined) data.result = JSON.stringify(patch.result ?? null);
  if (patch.error !== undefined) data.error = patch.error;
  if (patch.attempts !== undefined) data.attempts = patch.attempts;
  if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt;
  if (patch.progressStage !== undefined) data.progressStage = patch.progressStage;
  if (patch.errorCategory !== undefined) data.errorCategory = patch.errorCategory;
  if (patch.safeErrorMessage !== undefined) data.safeErrorMessage = patch.safeErrorMessage;
  if (patch.queuedAt !== undefined) data.queuedAt = patch.queuedAt;
  if (patch.cancelRequestedAt !== undefined) data.cancelRequestedAt = patch.cancelRequestedAt;
  if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt;
  if (patch.inputBytes !== undefined) data.inputBytes = patch.inputBytes;
  if (patch.outputBytes !== undefined) data.outputBytes = patch.outputBytes;
  return data;
}

/**
 * Prisma-backed JobRepository. JSON payloads/results are (de)serialized here so
 * the domain `Job` carries already-deserialized values and the schema stays
 * portable across SQLite and Postgres (no Json column type).
 */
export class PrismaJobRepository implements IJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: JobCreateInput): Promise<Job> {
    const status = input.status ?? "queued";
    const row = await this.prisma.job.create({
      data: {
        type: input.type,
        status,
        payload: JSON.stringify(input.payload ?? null),
        maxAttempts: input.maxAttempts ?? 3,
        ownerType: input.ownerType ?? null,
        ownerId: input.ownerId ?? null,
        workspaceId: input.workspaceId ?? null,
        toolSlug: input.toolSlug ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        progressStage: input.progressStage ?? null,
        expiresAt: input.expiresAt ?? null,
        inputBytes: input.inputBytes ?? null,
        // Legacy callers create directly as `queued`; record that truthfully so
        // queue-wait time is measurable without a second source of truth.
        queuedAt: status === "queued" ? new Date() : null,
      },
    });
    return toDomain(row);
  }

  async get(id: string): Promise<Job | null> {
    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async update(
    id: string,
    patch: JobUpdatePatch,
    opts: JobWriteOptions = {},
  ): Promise<Job | null> {
    // Fenced: the same conditional `updateMany` the status CAS uses, so a write
    // from a worker whose attempt was recovered lands nowhere — including on
    // `updatedAt`, which is the lease. An unfenced progress write from a
    // superseded worker would refresh the lease of a row it no longer owns and
    // hide the live worker's own staleness from the reaper.
    if (opts.expectAttempts !== undefined) {
      const res = await this.prisma.job.updateMany({
        where: { id, attempts: opts.expectAttempts },
        data: toUpdateData(patch),
      });
      if (res.count === 0) return null;
      const row = await this.prisma.job.findUnique({ where: { id } });
      return row ? toDomain(row) : null;
    }
    const row = await this.prisma.job.update({
      where: { id },
      data: toUpdateData(patch),
    });
    return toDomain(row);
  }

  async transition(
    id: string,
    to: JobStatus,
    patch: JobTransitionPatch = {},
    opts: JobTransitionOptions = {},
  ): Promise<Job | null> {
    const current = await this.prisma.job.findUnique({ where: { id } });
    if (!current) return null;
    if (!isTransitionAllowed(current.status as JobStatus, to, opts)) return null;

    // Compare-and-swap on the status we validated against, and on the attempt
    // the caller claims to own. `updateMany` returns a count instead of throwing,
    // so a lost race (another worker moved the job between the read and the
    // write) reports 0 and we return null — the same answer as a lifecycle
    // refusal, because the caller must react identically.
    //
    // `attempts` is in the WHERE clause rather than checked against `current`
    // for the same reason `status` is: the check has to be part of the write, or
    // recovery can land in the window between the read and the update and the
    // stale worker still wins.
    const res = await this.prisma.job.updateMany({
      where: {
        id,
        status: current.status,
        ...(opts.expectAttempts !== undefined ? { attempts: opts.expectAttempts } : {}),
      },
      data: toUpdateData({ ...patch, status: to }),
    });
    if (res.count === 0) return null;

    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByStatus(status: JobStatus, limit = 100): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({
      where: { status },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toDomain);
  }

  /**
   * Stale `running` rows, oldest lease first.
   *
   * `updatedAt` is Prisma's `@updatedAt`, so it is maintained by the database
   * adapter on every write including `updateMany` — which is what the claim and
   * every progress write go through. That is the whole lease: no new column.
   */
  async listStaleRunning(before: Date, limit = 25): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({
      where: { status: "running", updatedAt: { lte: before } },
      take: limit,
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(toDomain);
  }

  async findByIdempotencyKey(
    ownerType: JobOwnerType,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<Job | null> {
    const row = await this.prisma.job.findFirst({
      where: { ownerType, ownerId, idempotencyKey },
      orderBy: { createdAt: "desc" },
    });
    return row ? toDomain(row) : null;
  }

  async listExpirable(now: Date, limit = 100): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({
      // Restricted to statuses the lifecycle can actually expire. `status: { not:
      // "expired" }` looks equivalent but is not: it also returns `failed` and
      // `cancelled` rows, whose expiry `transition` refuses, so oldest-first
      // batching would return the same permanently-refused rows every sweep and
      // never reach the `completed` ones that still hold bytes.
      where: { expiresAt: { lte: now }, status: { in: [...EXPIRABLE_STATUSES] } },
      take: limit,
      orderBy: { expiresAt: "asc" },
    });
    return rows.map(toDomain);
  }
}
