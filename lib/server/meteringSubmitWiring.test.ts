import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The submission path must reserve allowance, in the right place, from the right
 * identity — and give it back on every path that does not run the tool.
 *
 * WHY SOURCE TEXT. Same reason as `legacyJobOwnershipWiring.test.ts`: vitest here
 * is `environment: "node"` with no Next runtime, and `submitProcessingJob`
 * resolves its collaborators from `appContainer`, so invoking it in this suite
 * would stand up Prisma, storage and a worker to assert on statement order. The
 * behaviour of the metering service is covered against the real service in
 * `UsageMeteringService.test.ts`, and the worker seam in
 * `src/infrastructure/jobs/meteringPipeline.test.ts`. What is left — and what no
 * amount of service-level testing can see — is whether this function calls it,
 * and *where*. That is a property of the source, so it is asserted on the source.
 *
 * The three orderings below are each a real defect if inverted:
 *
 *  - authorize AFTER validate, or the reserved byte count is a `content-length`
 *    header the client chose.
 *  - authorize BEFORE upload, or a refused submission has already written the
 *    user's document to storage.
 *  - release on every non-running exit, or a failed upload permanently burns a
 *    user's daily allowance for work that never happened.
 *
 * Comments are stripped before matching, so a comment describing a call cannot
 * satisfy an assertion that the call exists.
 */

function code(...segments: string[]): string {
  const src = readFileSync(path.join(process.cwd(), ...segments), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** Index of `needle`, asserting presence so an absence is never a pass. */
function at(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  expect(idx, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

const submit = () => code("lib", "server", "processingJobSubmit.ts");
const route = () => code("app", "api", "jobs", "route.ts");

describe("admission is wired into the submission path", () => {
  it("authorizes through the metering service", () => {
    const s = submit();
    expect(s).toContain("Tokens.UsageMeteringService");
    expect(s).toContain("await metering.authorize({");
  });

  it("authorizes after validation, so the byte count is measured and not claimed", () => {
    const s = submit();
    expect(at(s, "await validateUpload(")).toBeLessThan(at(s, "await metering.authorize({"));
    // The reserved size is the validated size, not `file.size` or a header.
    expect(s).toMatch(/inputBytes: validated\.size/);
  });

  it("authorizes before the input is written to storage", () => {
    const s = submit();
    expect(at(s, "await metering.authorize({")).toBeLessThan(
      at(s, "await uploadService.uploadStream("),
    );
  });

  it("refuses when the decision says to, rather than only recording it", () => {
    const s = submit();
    expect(s).toMatch(/if \(authorization\.blocked\)/);
    expect(s).toContain("throw new UsageLimitError(authorization.decision)");
    // `blocked`, never `allowed`: observe mode reports an honest `allowed: false`
    // while deliberately not blocking, and gating on it here would start
    // enforcing limits the moment the meters were switched on.
    expect(s).not.toMatch(/if \(!authorization\.allowed\)/);
  });
});

describe("the reserved allowance is never silently kept", () => {
  it("releases on every failure that abandons the job for good", () => {
    const s = submit();
    expect(s).toContain("await metering.release(reservation)");
    // The awaits that can throw after the reservation exists AND leave no row
    // that could still run the work.
    for (const call of [
      "await uploadService.uploadStream(",
      "await jobs\n    .createJob(",
    ]) {
      const idx = at(s, call);
      const tail = s.slice(idx, idx + 900);
      expect(tail, `${call} must release the reservation on failure`).toContain(
        ".catch(releaseOnFailure)",
      );
    }
  });

  it("keeps the reservation when the queue handoff fails, because the job survives", () => {
    const s = submit();
    const idx = at(s, "await jobs.queueJob(job.id)");
    // Deliberately NOT released. `queueJob` rolls a failed handoff back to
    // `failed`/`internal_error`, which is retryable, so the row can still run and
    // the debit must stay attached to it. Releasing would leave the payload
    // naming a reservation that was already refunded, and the eventual terminal
    // settlement would refund it a second time — `release` and
    // `settleProcessingOutcome` apply their deltas independently and only the
    // latter is guarded by the once-per-job claim. That mints allowance.
    expect(s.slice(idx, idx + 200)).not.toContain(".catch(releaseOnFailure)");
    expect(s).toContain("const finalJob = await jobs.queueJob(job.id);");
  });

  it("releases when an idempotency key replays an existing job", () => {
    const s = submit();
    const idx = at(s, "if (deduplicated) {");
    const branch = s.slice(idx, idx + 400);
    // The original submission already paid for that run; charging the retrying
    // client again is the exact double-charge idempotency exists to prevent.
    expect(branch).toContain("await metering.release(reservation)");
  });

  it("hands the reservation to the worker so the outcome can settle it", () => {
    const s = submit();
    expect(s).toContain("usage: reservationRef(reservation)");
    // Serialized as an instant, because the refund must land in the window the
    // charge was taken in — not in whatever window the worker finishes in.
    expect(s).toMatch(/reservedAt: reservation\.reservedAt\.toISOString\(\)/);
  });
});

describe("identity comes from the session, not the request", () => {
  it("authorizes the resolved actor", () => {
    const s = submit();
    const idx = at(s, "await metering.authorize({");
    const call = s.slice(idx, idx + 300);
    expect(call).toContain("ownerType: actor.ownerType");
    expect(call).toContain("ownerId: actor.ownerId");
  });

  it("reads no owner from the multipart body", () => {
    const s = submit();
    // `actor` is a parameter the route fills from `resolveJobActor()`. If the
    // body could name an owner, it would have to be read here.
    expect(s).not.toMatch(/formData\.get\((["'])owner/);
    expect(s).not.toMatch(/formData\.get\((["'])(userId|plan)/);
  });

  it("is resolved server-side by the route before either pipeline runs", () => {
    const r = route();
    expect(r).toContain("await resolveJobActor()");
    expect(at(r, "await resolveJobActor()")).toBeLessThan(at(r, "submitProcessingJob("));
  });
});

describe("a refusal reaches the client as a refusal", () => {
  const body = () => code("lib", "server", "usageLimitResponse.ts");

  it("answers 429 with the meter's own retry hint", () => {
    const b = body();
    expect(b).toContain("status: 429");
    expect(b).toContain("Retry-After");
    // The document itself never appears in an error body.
    expect(b).not.toContain("originalName");
  });

  it("is built in one place, so neither route can answer differently", () => {
    // Two hand-rolled copies is how a body that leaks a counter in one route and
    // not the other ships. (Both routes keep their own rate-limiter 429; that one
    // is not a quota answer and carries no plan state.)
    for (const r of [route(), code("app", "api", "tools", "[slug]", "route.ts")]) {
      const branch = r.slice(at(r, "err instanceof UsageLimitError"));
      expect(branch.slice(0, 120)).toContain("usageLimitResponse(err)");
      expect(r).not.toContain("err.retryAfterSeconds");
      expect(r).not.toContain("err.meter");
    }
  });

  it("carries a stable machine-readable reason", () => {
    // The reason is what the browser keys the denial panel off. Without it a
    // refusal is indistinguishable from a rate limiter's 429 and gets the generic
    // banner, which is the bug this field prevents.
    expect(body()).toContain("reason: err.reason");
  });

  it("does not put the counter implementation in a public body", () => {
    // A meter key is an internal counter identifier, and (limit, used) is the
    // counter showing through. A client that wants numbers reads /api/usage, which
    // is owner-scoped and already sanitized for display.
    const b = body();
    expect(b).not.toContain("err.meter");
    expect(b).not.toContain("err.limit");
    expect(b).not.toContain("err.used");
    expect(b).not.toContain("err.plan");
  });
});

describe("a user's retry does not buy another operation", () => {
  it("does not authorize on the retry route", () => {
    // The customer meter is per logical job, not per attempt: the submission that
    // created this job already paid for it. Authorizing here would charge a second
    // operation for the same piece of work, which is the accounting bug a user
    // notices first.
    const r = code("app", "api", "jobs", "[id]", "retry", "route.ts");
    expect(r).toContain("retryJob");
    expect(r).not.toContain("authorize");
    expect(r).not.toContain("UsageMeteringService");
  });

  it("does not authorize inside retryJob either, or reset the attempt budget", () => {
    const svc = code("src", "application", "services", "ProcessingJobService.ts");
    const idx = at(svc, "async retryJob(");
    const fn = svc.slice(idx, idx + 3_000);
    expect(fn).not.toContain("authorize");
    // Attempts are NOT reset, so retry cannot be used to loop a job forever — and
    // the compute ledger keeps counting the real attempts.
    expect(fn).not.toMatch(/attempts:\s*0/);
    expect(fn).toContain("{ retry: true }");
  });
});

describe("the denial event is emitted once, by the server", () => {
  it("is recorded where the decision is made, not where it is displayed", () => {
    const svc = code("src", "application", "services", "UsageMeteringService.ts");
    expect(svc).toContain("ANALYTICS_EVENTS.limit_reached");
    // Through the taxonomy's sanitizer, so the row cannot carry a field the
    // allowlist has not approved.
    expect(svc).toContain("sanitizeEventProperties(ANALYTICS_EVENTS.limit_reached");
  });

  it("is emitted by no client surface, so a retried submit cannot duplicate it", () => {
    // A UI that emitted its own `limit_reached` would double every denial in the
    // calibration dataset — the dataset that decides whether enforcement turns on.
    // The authoritative emission is one per admission decision, server-side.
    for (const file of [
      ["components", "tools", "QuotaNotice.tsx"],
      ["components", "tools", "runners", "ServerToolRunner.tsx"],
      ["components", "tools", "runners", "PipelineToolRunner.tsx"],
      ["hooks", "useProcessingJob.ts"],
      ["components", "app", "usageViewModel.ts"],
    ]) {
      expect(code(...file), file.join("/")).not.toContain("limit_reached");
    }
  });
});
