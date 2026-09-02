import { describe, expect, it } from "vitest";
import type { Job } from "@/src/domain/entities/Job";
import {
  JobAuthorizationError,
  actorOwnsJob,
  assertActorOwnsJob,
  type JobActor,
} from "./jobOwnership";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    type: "processing",
    status: "queued",
    payload: {},
    result: null,
    error: null,
    attempts: 0,
    maxAttempts: 3,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ownerType: "user",
    ownerId: "u1",
    workspaceId: null,
    toolSlug: "compress-pdf",
    idempotencyKey: null,
    progressStage: null,
    errorCategory: null,
    safeErrorMessage: null,
    queuedAt: null,
    cancelRequestedAt: null,
    expiresAt: null,
    inputBytes: null,
    outputBytes: null,
    ...over,
  } as Job;
}

const user: JobActor = { ownerType: "user", ownerId: "u1" };
const otherUser: JobActor = { ownerType: "user", ownerId: "u2" };
const anon: JobActor = { ownerType: "anon", ownerId: "u1" };

describe("actorOwnsJob", () => {
  it("grants access to the recorded owner", () => {
    expect(actorOwnsJob(user, job())).toBe(true);
  });

  it("denies a different user with the same job", () => {
    expect(actorOwnsJob(otherUser, job())).toBe(false);
  });

  it("denies an anon visitor whose id happens to equal a user id", () => {
    // Ids come from different namespaces (session user ids vs minted cookie
    // UUIDs), so a collision should be impossible — but comparing only the id
    // would make "impossible" the thing standing between two people's documents.
    // The type is part of the identity.
    expect(actorOwnsJob(anon, job())).toBe(false);
  });

  it("denies everyone when the job has no recorded owner", () => {
    // An owner-less job (a legacy row, or one created before ownership existed)
    // is not public — it is unclaimed. Treating null as a wildcard would expose
    // every such row to every visitor.
    expect(actorOwnsJob(user, job({ ownerType: null, ownerId: null }))).toBe(false);
    expect(actorOwnsJob(user, job({ ownerId: null }))).toBe(false);
    expect(actorOwnsJob(user, job({ ownerType: null }))).toBe(false);
  });

  it("requires the workspace to match when the job records one", () => {
    const scoped = job({ workspaceId: "ws1" });
    expect(actorOwnsJob({ ...user, workspaceId: "ws1" }, scoped)).toBe(true);
    expect(actorOwnsJob({ ...user, workspaceId: "ws2" }, scoped)).toBe(false);
    // Same user, right identity, but no workspace context: a job scoped to a
    // workspace should not be readable outside it.
    expect(actorOwnsJob(user, scoped)).toBe(false);
  });

  it("ignores the actor's workspace when the job records none", () => {
    // A personal job stays readable by its owner regardless of which workspace
    // they happen to be viewing.
    expect(actorOwnsJob({ ...user, workspaceId: "ws9" }, job())).toBe(true);
  });
});

describe("legacy anonymous job ownership", () => {
  // The scenario the legacy-authorization fix turns on. A `pdf-tool` row is now
  // stamped with the submitting visitor's minted anon id; these assert the row
  // is reachable by exactly that visitor and no one else.
  const uuidA = "7f3c1d20-0a4e-4c1b-9f2d-8b6a5e4c3d21";
  const uuidB = "11111111-2222-3333-4444-555555555555";
  const anonRow = job({
    type: "pdf-tool",
    ownerType: "anon",
    ownerId: uuidA,
    workspaceId: null,
  });

  it("grants the anonymous submitter access to its own job", () => {
    expect(actorOwnsJob({ ownerType: "anon", ownerId: uuidA }, anonRow)).toBe(true);
  });

  it("denies a different anonymous visitor (a different cookie)", () => {
    // The whole point of a per-visitor id over a shared "anon" bucket: visitor B
    // must not read visitor A's job even though both are unauthenticated.
    expect(actorOwnsJob({ ownerType: "anon", ownerId: uuidB }, anonRow)).toBe(false);
  });

  it("denies a signed-in user whose id equals the anon cookie", () => {
    expect(actorOwnsJob({ ownerType: "user", ownerId: uuidA }, anonRow)).toBe(false);
  });

  it("denies everyone for a pre-existing unowned legacy row", () => {
    // Rows created before this fix have null owners and cannot be back-filled —
    // there is nothing to back-fill from. They fail closed for their creator too;
    // this asserts that is the actual behaviour, not an aspiration.
    const legacy = job({ type: "pdf-tool", ownerType: null, ownerId: null });
    expect(actorOwnsJob({ ownerType: "anon", ownerId: uuidA }, legacy)).toBe(false);
    expect(actorOwnsJob({ ownerType: "user", ownerId: "u1" }, legacy)).toBe(false);
  });
});

describe("assertActorOwnsJob", () => {
  it("passes for the owner", () => {
    expect(() => assertActorOwnsJob(user, job())).not.toThrow();
  });

  it("throws JobAuthorizationError for a non-owner", () => {
    expect(() => assertActorOwnsJob(otherUser, job())).toThrow(JobAuthorizationError);
  });

  it("does not put the job id or owner in the message", () => {
    // The message can reach a log line that gets pasted somewhere; it should not
    // carry identifiers that let a reader correlate users to jobs.
    try {
      assertActorOwnsJob(otherUser, job());
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("job_1");
      expect(msg).not.toContain("u1");
      expect(msg).not.toContain("u2");
    }
  });
});
