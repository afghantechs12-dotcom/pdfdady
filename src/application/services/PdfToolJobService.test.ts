import { describe, expect, it } from "vitest";

import {
  PdfToolJobService,
  PDF_TOOL_JOB_TYPE,
  PDF_TOOL_BATCH_JOB_TYPE,
  type PdfToolJobPayload,
  type PdfToolBatchJobPayload,
} from "./PdfToolJobService";
import type { EnqueueInput, IQueue } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { actorOwnsJob, type JobActor } from "./jobOwnership";

/**
 * A queue that records exactly what the service asked it to enqueue.
 *
 * The assertions below are about the *arguments*, not the persisted row: the
 * adapters' own tests already cover argument→row, and this file is where a
 * regression in the service (an owner dropped between the actor and the queue)
 * would show up. Both halves are needed — the row is only owned if every hop
 * carries it.
 */
class CapturingQueue implements IQueue {
  readonly calls: EnqueueInput[] = [];
  constructor(private readonly repo: IJobRepository) {}
  async enqueue(input: EnqueueInput) {
    this.calls.push(input);
    return this.repo.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
      ownerType: input.ownerType ?? null,
      ownerId: input.ownerId ?? null,
      workspaceId: input.workspaceId ?? null,
      toolSlug: input.toolSlug ?? null,
    });
  }
  async pull() {
    return null;
  }
  async requeue() {}
  get last(): EnqueueInput {
    const call = this.calls.at(-1);
    if (!call) throw new Error("nothing was enqueued");
    return call;
  }
}

const noopWorker = {
  register() {},
  start() {},
  stop() {},
  running: false,
  activeCount: 0,
  async cancel() {},
  async clearCancellation() {},
  async requeue() {},
} satisfies IWorker;

function makeService() {
  const repo = new InMemoryJobRepository();
  const queue = new CapturingQueue(repo);
  return { repo, queue, service: new PdfToolJobService(queue, repo, noopWorker) };
}

/** A specific anonymous visitor, the way `resolveJobActor` mints them. */
const ANON: JobActor = {
  ownerType: "anon",
  ownerId: "7f3c1d20-0a4e-4c1b-9f2d-8b6a5e4c3d21",
};

const singleInput = (actor: JobActor) => ({
  slug: "compress-pdf",
  inputFileId: "file-1",
  originalName: "in.pdf",
  ext: ".pdf",
  baseName: "in",
  inputSize: 1234,
  options: {},
  ownerType: "anon" as const,
  ownerId: "anon",
  actor,
});

const batchInput = (actor: JobActor) => ({
  slug: "compress-pdf",
  inputs: [
    { fileId: "file-1", originalName: "a.pdf", ext: ".pdf", baseName: "a", size: 10 },
    { fileId: "file-2", originalName: "b.pdf", ext: ".pdf", baseName: "b", size: 20 },
  ],
  options: {},
  ownerType: "anon" as const,
  ownerId: "anon",
  actor,
});

describe("PdfToolJobService ownership", () => {
  it("puts the actor on the enqueued job, not just in the payload", async () => {
    const { queue, service } = makeService();
    await service.enqueue(singleInput(ANON));

    expect(queue.last.type).toBe(PDF_TOOL_JOB_TYPE);
    expect(queue.last.ownerType).toBe("anon");
    expect(queue.last.ownerId).toBe(ANON.ownerId);
    expect(queue.last.toolSlug).toBe("compress-pdf");
  });

  it("keeps the StoredFile owner in the payload separate from the job owner", async () => {
    // Two different notions of ownership share the word "owner": the payload's
    // scopes the staged FILE (a shared "anon" storage bucket), the enqueue's
    // scopes the ROW (this one visitor). Collapsing them either way is a bug —
    // a shared row owner lets any visitor read any job, and a per-visitor file
    // owner would change retention/dedup semantics for no security gain.
    const { queue, service } = makeService();
    await service.enqueue(singleInput(ANON));

    const payload = queue.last.payload as PdfToolJobPayload;
    expect(payload.ownerId).toBe("anon");
    expect(queue.last.ownerId).toBe(ANON.ownerId);
    expect(queue.last.ownerId).not.toBe(payload.ownerId);
  });

  it("puts the actor on a batch job too", async () => {
    const { queue, service } = makeService();
    await service.enqueueBatch(batchInput(ANON));

    expect(queue.last.type).toBe(PDF_TOOL_BATCH_JOB_TYPE);
    expect(queue.last.ownerType).toBe("anon");
    expect(queue.last.ownerId).toBe(ANON.ownerId);
    expect(queue.last.toolSlug).toBe("compress-pdf");
    const payload = queue.last.payload as PdfToolBatchJobPayload;
    expect(payload.inputs).toHaveLength(2);
  });

  it("carries a signed-in actor's workspace onto the job", async () => {
    const { queue, service } = makeService();
    const user: JobActor = {
      ownerType: "user",
      ownerId: "user-abc",
      workspaceId: "ws-1",
    };
    await service.enqueue(singleInput(user));

    expect(queue.last.ownerType).toBe("user");
    expect(queue.last.ownerId).toBe("user-abc");
    expect(queue.last.workspaceId).toBe("ws-1");
  });

  it("normalizes a workspace-less actor to null rather than undefined", async () => {
    // `undefined` would be indistinguishable from "field forgotten" at the
    // repository boundary, and a workspace check reads the stored value.
    const { queue, service } = makeService();
    await service.enqueue(singleInput(ANON));
    expect(queue.last.workspaceId).toBeNull();
  });

  it("produces a row its own submitter owns and a different visitor does not", async () => {
    // The end-to-end property the fix exists for, asserted on a real row: the
    // creator passes the same ownership predicate the routes use, and another
    // anonymous visitor — a different cookie — does not.
    const { repo, service } = makeService();
    const job = await service.enqueue(singleInput(ANON));
    const row = await repo.get(job.id);
    expect(row).not.toBeNull();

    expect(actorOwnsJob(ANON, row!)).toBe(true);
    expect(
      actorOwnsJob(
        { ownerType: "anon", ownerId: "11111111-2222-3333-4444-555555555555" },
        row!,
      ),
    ).toBe(false);
  });
});
