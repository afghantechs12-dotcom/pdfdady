import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The legacy job endpoints must actually CALL the ownership gate.
 *
 * THE BUG THIS PINS. `/api/jobs/[id]`, `/download`, `/cancel` and `/progress`
 * each dispatch on the stored job type: a `processing` row goes through
 * ProcessingJobService, which enforces ownership, and anything else falls through
 * to the legacy `PdfToolJobService`. The legacy fall-through had no ownership
 * check at all, so with no session whatsoever a caller who knew a job id got
 *
 *   GET /api/jobs/{id}          → 200 (someone else's job status)
 *   GET /api/jobs/{id}/download → 302 → signed URL → 200 → their actual PDF
 *
 * while the pipeline branch of the same four files answered 404 correctly. Every
 * unit test of the ownership predicate passed throughout: `actorOwnsJob` was
 * never wrong, it was never called.
 *
 * WHY SOURCE TEXT. vitest here is `environment: "node"` with no Next runtime, so
 * a route handler cannot be invoked with a real Request and cookie jar in this
 * suite — `scripts/legacy-job-ownership-probe.mjs` does that against a running
 * production server. What a Node test CAN do is assert the call exists and is
 * ordered before the data read, which is exactly the property that went missing.
 * The probe proves the behaviour; this proves the mechanism, in every clone,
 * without a server.
 *
 * Comments are stripped before matching, so a comment naming the gate cannot
 * satisfy an assertion about calling it. Each slice is computed inside a `lazy`
 * thunk so a renamed anchor fails its own test instead of collapsing the file at
 * import time.
 */

const GATE = "legacyJobAccessDenied";

function lazy<T>(fn: () => T): () => T {
  return fn;
}

/** Reads a repo file with comments removed, so matches are on real code only. */
function code(...segments: string[]): string {
  const src = readFileSync(path.join(process.cwd(), ...segments), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** Index of `needle`, asserting it is present so an absence is never a pass. */
function at(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  expect(idx, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

const ROUTES = [
  { name: "status", seg: ["app", "api", "jobs", "[id]", "route.ts"] },
  { name: "download", seg: ["app", "api", "jobs", "[id]", "download", "route.ts"] },
  { name: "cancel", seg: ["app", "api", "jobs", "[id]", "cancel", "route.ts"] },
  { name: "progress", seg: ["app", "api", "jobs", "[id]", "progress", "route.ts"] },
] as const;

describe("every legacy job route calls the ownership gate", () => {
  for (const route of ROUTES) {
    const src = lazy(() => code(...route.seg));

    it(`${route.name}: imports the gate from processingJobApi`, () => {
      const s = src();
      expect(s).toContain(GATE);
      expect(s).toMatch(/from "@\/lib\/server\/processingJobApi"/);
    });

    it(`${route.name}: awaits the gate and returns its response`, () => {
      const s = src();
      // Calling it is not enough — the result has to short-circuit the handler.
      // `await legacyJobAccessDenied(row)` whose value is discarded would leave
      // the leak open and still contain the identifier.
      expect(s).toMatch(new RegExp(`await ${GATE}\\(row\\)`));
      expect(s).toMatch(/if \(denied\) return denied;/);
    });

    it(`${route.name}: gates the legacy branch before reading job data`, () => {
      const s = src();
      // The ordering IS the security property: a gate placed after the read has
      // already loaded (and in `/download`'s case, signed a URL for) data that
      // does not belong to the caller.
      const gateAt = at(s, `await ${GATE}(row)`);
      const readAt = at(s, "jobService.getStatus(id)");
      expect(gateAt).toBeLessThan(readAt);
    });

    it(`${route.name}: gates after the pipeline dispatch, not instead of it`, () => {
      // The pipeline branch has its own in-service check and returns earlier; the
      // legacy gate must not be hoisted above that dispatch, or a pipeline job
      // would be checked twice and the legacy row's null-owner rules would start
      // applying to rows that have real owners.
      const s = src();
      expect(at(s, "isProcessingJob(row)")).toBeLessThan(at(s, `await ${GATE}(row)`));
    });
  }

  it("progress: refuses before the SSE stream is constructed", () => {
    // An unauthorized subscriber must get a plain 404, not an open connection
    // that reports `not-found` frames forever. Deciding inside `start()` would
    // surface a refusal as a broken stream.
    const s = code(...ROUTES[3].seg);
    expect(at(s, `await ${GATE}(row)`)).toBeLessThan(at(s, "new ReadableStream"));
  });
});

describe("the gate denies rather than trusts", () => {
  const src = lazy(() => code("lib", "server", "processingJobApi.ts"));

  it("runs the real ownership predicate against a server-resolved actor", () => {
    const s = src();
    const body = s.slice(at(s, `export async function ${GATE}`));
    expect(body).toContain("await resolveJobActor()");
    expect(body).toContain("assertActorOwnsJob(actor, row)");
  });

  it("treats a missing row as a denial on the same branch", () => {
    // Same branch, not merely the same status code: that is what keeps the
    // endpoint from becoming an existence oracle if one answer is later edited.
    const s = src();
    const body = s.slice(at(s, `export async function ${GATE}`));
    expect(body).toMatch(/if \(!row\) throw new JobAuthorizationError\(\)/);
  });

  it("answers 404, never 403", () => {
    const s = src();
    expect(s).toMatch(/JobAuthorizationError \|\| err instanceof JobNotFoundError/);
    expect(s).toMatch(/"Job not found\."[\s\S]{0,40}status: 404/);
    expect(s).not.toContain("status: 403");
  });

  it("denies when the actor cannot be resolved, rather than proceeding", () => {
    // Fail-closed: if we cannot establish who is asking, we cannot establish
    // that the job is theirs. A bare `catch { return null }` here would reopen
    // the hole for any request that made actor resolution throw.
    const s = src();
    const body = s.slice(at(s, `export async function ${GATE}`));
    expect(body).toMatch(/catch \(err\) \{[\s\S]*?return jobErrorResponse\(/);
    expect(body).not.toMatch(/catch[\s\S]{0,80}return null/);
  });
});

describe("legacy job rows are created with an owner", () => {
  it("both submit routes resolve the actor server-side and pass it on", () => {
    // A gate on the read side is worthless if the write side leaves the row
    // unowned: `actorOwnsJob` reads a null owner as "belongs to nobody", so an
    // unstamped row 404s for its own creator. The two halves only work together.
    for (const seg of [
      ["app", "api", "jobs", "route.ts"],
      ["app", "api", "tools", "[slug]", "route.ts"],
    ]) {
      const s = code(...seg);
      expect(s, seg.join("/")).toContain("await resolveJobActor()");
      expect(s, seg.join("/")).toMatch(/submitToolJob\(\{[^}]*actor[^}]*\}\)/);
    }
  });

  it("the actor is never taken from the request body or a query param", () => {
    // Client-supplied ownership is not ownership. The only source is the
    // session/anon cookie, read on the server.
    for (const seg of [
      ["app", "api", "jobs", "route.ts"],
      ["app", "api", "tools", "[slug]", "route.ts"],
      ["lib", "server", "toolJobSubmit.ts"],
    ]) {
      const s = code(...seg);
      expect(s, seg.join("/")).not.toMatch(/ownerId[^\n]*(formData|searchParams)/);
      expect(s, seg.join("/")).not.toMatch(/actor[^\n]*=[^\n]*(formData|searchParams)/);
    }
  });

  it("the tool service forwards the actor to the queue on both job types", () => {
    const s = code("src", "application", "services", "PdfToolJobService.ts");
    // Two enqueue call sites (single + batch); both must carry the actor, and the
    // count guards against a third being added without one.
    const calls = s.match(/this\.queue\.enqueue\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain("ownerType: input.actor.ownerType");
      expect(call).toContain("ownerId: input.actor.ownerId");
      expect(call).toContain("toolSlug: input.slug");
    }
  });

  it("all three queue adapters persist the owner onto the row", () => {
    // RedisQueue has no unit test — it opens a real connection in its
    // constructor — so this is the only thing standing between a production
    // Redis deployment and rows born unowned again.
    for (const adapter of ["InMemoryQueue.ts", "RedisQueue.ts", "DatabaseQueue.ts"]) {
      const s = code("src", "infrastructure", "queue", adapter);
      const create = s.slice(at(s, "this.jobRepo.create({"));
      expect(create, adapter).toContain("ownerType: input.ownerType");
      expect(create, adapter).toContain("ownerId: input.ownerId");
      expect(create, adapter).toContain("toolSlug: input.toolSlug");
    }
  });
});
