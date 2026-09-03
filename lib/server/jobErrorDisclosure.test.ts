import { describe, expect, it } from "vitest";
import { JobNotFoundError } from "@/src/application/services/ProcessingJobService";
import { JobAuthorizationError } from "@/src/application/services/jobOwnership";
import { jobErrorResponse } from "./processingJobApi";

/**
 * R12 — a foreign job answers exactly like a job that does not exist.
 *
 * Every legacy job route funnels its refusal through `jobErrorResponse`, and the
 * non-disclosure guarantee is that "not yours" and "not real" are the same
 * answer: a 403 on the first would turn the endpoint into an existence oracle
 * for enumerated ids. Until now the only thing holding that was a source scan
 * (`legacyJobOwnershipWiring.test.ts` asserting the file contains no
 * `status: 403`), which cannot see what the function actually returns — a
 * different literal, a different body, or a mapping added above this branch
 * would all have stayed green.
 */
async function answer(err: unknown) {
  const res = jobErrorResponse(err);
  return { status: res.status, body: await res.json() };
}

describe("job refusal disclosure", () => {
  it("answers 404 for a job the caller does not own", async () => {
    const { status, body } = await answer(new JobAuthorizationError());

    expect(status).toBe(404);
    expect(body).toEqual({ error: "Job not found." });
  });

  it("is byte-identical to the answer for a job that does not exist", async () => {
    const foreign = await answer(new JobAuthorizationError());
    const missing = await answer(new JobNotFoundError());

    expect(foreign).toEqual(missing);
  });

  it("never distinguishes the two with a status code", async () => {
    for (const err of [new JobAuthorizationError(), new JobNotFoundError()]) {
      const { status } = await answer(err);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    }
  });
});
