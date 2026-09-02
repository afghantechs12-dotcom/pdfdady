import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseQueue } from "./DatabaseQueue";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { PROCESSING_JOB_TYPE } from "@/src/application/services/ProcessingJobService";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";

const logger = () => new ConsoleLogger("error");

/**
 * The table-as-queue adapter. What is under test is mostly *what it refuses to
 * own*: it holds no list, so a job's runnability is always a fact about the row.
 * The tests below are written to fail if that ever stops being true — if the
 * queue starts remembering something the row does not say.
 */
describe("DatabaseQueue", () => {
  let repo: IJobRepository;
  beforeEach(() => {
    repo = new InMemoryJobRepository();
  });

  function queue(opts: Parameters<typeof makeQueue>[1] = {}) {
    return makeQueue(repo, opts);
  }
  function makeQueue(r: IJobRepository, opts: ConstructorParameters<typeof DatabaseQueue>[2] = {}) {
    return new DatabaseQueue(r, logger(), { pollMs: 1, ...opts });
  }

  describe("enqueue and pull", () => {
    it("makes an enqueued job immediately pullable", async () => {
      const q = queue();
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: { jobId: "x" } });
      expect(job.status).toBe("queued");
      expect((await q.pull(0))?.id).toBe(job.id);
    });

    it("returns null on an empty queue rather than hanging", async () => {
      expect(await queue().pull(0)).toBeNull();
    });

    it("waits up to the timeout for work that arrives late", async () => {
      const q = queue({ pollMs: 5 });
      // Enqueued after the pull is already blocked, which is the case that
      // matters: the worker's loop calls `pull(1000)` on an empty queue, and a
      // request creating a job during that window must not wait a whole cycle.
      const pulled = q.pull(500);
      setTimeout(() => {
        void q.enqueue({ type: PROCESSING_JOB_TYPE, payload: { jobId: "late" } });
      }, 10);
      expect(await pulled).not.toBeNull();
    });

    it("persists the owner from the enqueue onto the row", async () => {
      // The DatabaseQueue is the adapter that runs when a real Redis/DB queue is
      // configured. It must carry the owner through to the row exactly like the
      // in-memory default, or the legacy ownership check would pass in-process
      // tests yet fail in production where a different adapter is wired.
      const q = queue();
      const job = await q.enqueue({
        type: "pdf-tool",
        payload: { jobId: "y" },
        ownerType: "user",
        ownerId: "user-123",
        workspaceId: "ws-9",
        toolSlug: "compress-pdf",
      });
      const stored = await repo.get(job.id);
      expect(stored?.ownerType).toBe("user");
      expect(stored?.ownerId).toBe("user-123");
      expect(stored?.workspaceId).toBe("ws-9");
      expect(stored?.toolSlug).toBe("compress-pdf");
    });

    it("leaves the owner null when the enqueue omits it", async () => {
      const q = queue();
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      const stored = await repo.get(job.id);
      expect(stored?.ownerType).toBeNull();
      expect(stored?.ownerId).toBeNull();
      expect(stored?.toolSlug).toBeNull();
    });

    it("serves the oldest queued job first", async () => {
      const q = queue({ inflightTtlMs: 60_000 });
      const first = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: 1 });
      const second = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: 2 });
      const third = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: 3 });
      expect([
        (await q.pull(0))?.id,
        (await q.pull(0))?.id,
        (await q.pull(0))?.id,
      ]).toEqual([first.id, second.id, third.id]);
    });
  });

  describe("type filtering", () => {
    it("serves only the types this worker was given handlers for", async () => {
      const mine = await repo.create({ type: PROCESSING_JOB_TYPE, payload: {} });
      await repo.create({ type: "document-ingestion", payload: {} });
      const q = queue({ types: [PROCESSING_JOB_TYPE] });
      expect((await q.pull(0))?.id).toBe(mine.id);
      expect(await q.pull(0)).toBeNull();
    });

    it("never hands a foreign type to a filtered worker, even when it is first in line", async () => {
      // The ordering matters. A filtered worker that stopped scanning at the
      // head of the queue would report "empty" while its own work waited behind
      // somebody else's — and the generic worker *fails* a job it has no handler
      // for, so serving the foreign job instead would destroy it.
      await repo.create({ type: "document-ingestion", payload: {} });
      await repo.create({ type: "email", payload: {} });
      const mine = await repo.create({ type: PROCESSING_JOB_TYPE, payload: {} });
      const q = queue({ types: [PROCESSING_JOB_TYPE] });
      expect((await q.pull(0))?.id).toBe(mine.id);
    });

    it("serves every type when no filter is configured", async () => {
      await repo.create({ type: "document-ingestion", payload: {} });
      await repo.create({ type: PROCESSING_JOB_TYPE, payload: {} });
      const q = queue();
      expect(await q.pull(0)).not.toBeNull();
      expect(await q.pull(0)).not.toBeNull();
    });
  });

  describe("the row is the queue", () => {
    it("stops serving a job the moment it leaves queued", async () => {
      const q = queue();
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      await repo.transition(job.id, "running", { startedAt: new Date() });
      expect(await q.pull(0)).toBeNull();
    });

    it("stops serving a job cancelled while it waited in line", async () => {
      // The property a separate in-process list cannot offer: cancellation is a
      // write to the row, and the queue reads the row, so there is no window in
      // which a cancelled job is still dispatchable.
      const q = queue();
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      await repo.transition(job.id, "cancelled", { finishedAt: new Date() });
      expect(await q.pull(0)).toBeNull();
    });

    it("serves a revived job again without being told to", async () => {
      // `requeue` is a no-op on purpose. The status write is what revives the
      // job; this asserts the queue needs nothing else, so a retry path that
      // forgets to call `requeue` still works.
      const q = queue({ inflightTtlMs: 60_000 });
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      await repo.transition(job.id, "running", { startedAt: new Date() });
      await repo.transition(job.id, "failed", { finishedAt: new Date() });
      expect(await q.pull(0)).toBeNull();

      await repo.transition(job.id, "queued", { finishedAt: null }, { retry: true });
      expect((await q.pull(0))?.id).toBe(job.id);
    });

    it("reports a revived job's current attempt count, not the one it was enqueued with", async () => {
      const q = queue({ inflightTtlMs: 0 });
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {}, maxAttempts: 3 });
      await repo.update(job.id, { attempts: 2 });
      // The worker's retry loop starts at `job.attempts + 1`. A queue that
      // cached the row at enqueue time would hand back `attempts: 0` and grant
      // a spent job a fresh budget every time it was pulled.
      expect((await q.pull(0))?.attempts).toBe(2);
    });
  });

  describe("in-flight de-duplication", () => {
    it("does not serve the same job twice to one process", async () => {
      const q = queue({ inflightTtlMs: 60_000 });
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      expect((await q.pull(0))?.id).toBe(job.id);
      // Still `queued` in the table — the claim has not happened yet — but this
      // process already has it.
      expect((await repo.get(job.id))?.status).toBe("queued");
      expect(await q.pull(0)).toBeNull();
    });

    it("looks past held ids to work waiting behind them", async () => {
      const q = queue({ inflightTtlMs: 60_000 });
      const first = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: 1 });
      const second = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: 2 });
      expect((await q.pull(0))?.id).toBe(first.id);
      // A `take: 1` query would report an empty queue here.
      expect((await q.pull(0))?.id).toBe(second.id);
    });

    it("offers a held id again once the hold lapses", async () => {
      // Self-healing matters: a worker that pulled and then crashed before
      // claiming leaves the row `queued` forever. The hold is a courtesy with an
      // expiry, not a lease that can lose work.
      const q = queue({ inflightTtlMs: 15 });
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      expect((await q.pull(0))?.id).toBe(job.id);
      expect(await q.pull(0)).toBeNull();
      await new Promise((r) => setTimeout(r, 25));
      expect((await q.pull(0))?.id).toBe(job.id);
    });

    it("releases a held id when the job is explicitly requeued", async () => {
      const q = queue({ inflightTtlMs: 60_000 });
      const job = await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      await q.pull(0);
      await q.requeue(job.id);
      // Without the release, a retry inside the hold window would sit unserved
      // for the whole TTL.
      expect((await q.pull(0))?.id).toBe(job.id);
    });

    it("holds are per process, so a second worker still sees the job", async () => {
      const a = makeQueue(repo, { inflightTtlMs: 60_000 });
      const b = makeQueue(repo, { inflightTtlMs: 60_000 });
      const job = await a.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      expect((await a.pull(0))?.id).toBe(job.id);
      // Deliberate, not a bug: correctness comes from the claim, and a hold that
      // spanned processes would be a distributed lock this adapter does not have.
      expect((await b.pull(0))?.id).toBe(job.id);
    });
  });

  describe("two workers, one job", () => {
    it("lets exactly one of them claim it", async () => {
      const a = makeQueue(repo);
      const b = makeQueue(repo);
      const job = await a.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });

      const [pulledA, pulledB] = [await a.pull(0), await b.pull(0)];
      expect(pulledA?.id).toBe(job.id);
      expect(pulledB?.id).toBe(job.id);

      const claims = await Promise.all([
        repo.transition(job.id, "running", { startedAt: new Date() }),
        repo.transition(job.id, "running", { startedAt: new Date() }),
      ]);
      // This is the whole safety argument for the adapter: `pull` may duplicate,
      // the compare-and-swap may not.
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
    });

    it("does not let the loser's refusal cost the winner anything", async () => {
      const a = makeQueue(repo);
      const b = makeQueue(repo);
      const job = await a.enqueue({ type: PROCESSING_JOB_TYPE, payload: {} });
      await a.pull(0);
      await b.pull(0);
      await repo.transition(job.id, "running", { startedAt: new Date() });
      const loser = await repo.transition(job.id, "running", { startedAt: new Date() });

      expect(loser).toBeNull();
      const row = await repo.get(job.id);
      expect(row?.status).toBe("running");
      // A refused claim writes nothing, so the winner's run is untouched.
      expect(row?.attempts).toBe(0);
    });

    it("shares out a backlog rather than both draining it", async () => {
      const a = makeQueue(repo, { inflightTtlMs: 60_000 });
      const b = makeQueue(repo, { inflightTtlMs: 60_000 });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push((await a.enqueue({ type: PROCESSING_JOB_TYPE, payload: i })).id);
      }
      const claimed: string[] = [];
      for (let i = 0; i < 6; i++) {
        for (const q of [a, b]) {
          const j = await q.pull(0);
          if (!j) continue;
          if (await repo.transition(j.id, "running", { startedAt: new Date() })) {
            claimed.push(j.id);
          }
        }
      }
      // Every job run exactly once, by whichever worker won it.
      expect([...claimed].sort()).toEqual([...ids].sort());
    });
  });

  describe("the scan window", () => {
    it("keeps serving work with a long backlog of held ids at the head", async () => {
      // The scan is bounded (25 rows). With more held ids than that at the head,
      // the queue reports empty until a hold lapses — recorded here so the bound
      // is a known number rather than a surprise. It self-heals: holds expire and
      // claimed jobs leave `queued`, so nothing is lost, only delayed.
      const q = queue({ inflightTtlMs: 20 });
      for (let i = 0; i < 30; i++) {
        await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: i });
      }
      const held: string[] = [];
      for (let i = 0; i < 25; i++) {
        const j = await q.pull(0);
        if (j) held.push(j.id);
      }
      expect(held).toHaveLength(25);
      expect(await q.pull(0)).toBeNull();

      await new Promise((r) => setTimeout(r, 30));
      expect(await q.pull(0)).not.toBeNull();
    });

    it("keeps draining once the head is claimed", async () => {
      // The realistic version of the above: a worker claims what it pulls, those
      // rows leave `queued`, and the window slides.
      const q = queue({ inflightTtlMs: 60_000 });
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        ids.push((await q.enqueue({ type: PROCESSING_JOB_TYPE, payload: i })).id);
      }
      const claimed: string[] = [];
      for (let i = 0; i < 30; i++) {
        const j = await q.pull(0);
        if (!j) break;
        await repo.transition(j.id, "running", { startedAt: new Date() });
        claimed.push(j.id);
      }
      expect(claimed).toEqual(ids);
    });
  });
});
