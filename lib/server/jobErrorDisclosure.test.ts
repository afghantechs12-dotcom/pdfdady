import { describe, expect, it, vi } from "vitest";
import { JobNotFoundError } from "@/src/application/services/ProcessingJobService";
import { JobAuthorizationError } from "@/src/application/services/jobOwnership";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { jobErrorResponse } from "./processingJobApi";

const error = vi.fn();
const logger = { debug() {}, info() {}, warn() {}, error, child: () => logger };
appContainer.register(Tokens.Logger, () => logger);

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

/**
 * The other half of that funnel: an UNCLASSIFIED error is a 500 whose body is
 * deliberately vague, so if this line does not log, the only description of the
 * fault is discarded at the one moment it exists. A runtime probe found exactly
 * that — a malformed multipart body produced a 500 with no server log line at
 * all — which is why it is asserted rather than assumed.
 */
describe("an unclassified job error is logged before it is hidden", () => {
  it("logs the error name and message, and still answers a vague 500", async () => {
    error.mockClear();
    const { status, body } = await answer(new TypeError("Failed to parse body as FormData."));

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][1]).toMatchObject({
      errorName: "TypeError",
      errorMessage: "Failed to parse body as FormData.",
    });
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Unexpected server error." });
  });

  it("logs a non-Error throw without assuming it has .name or .message", async () => {
    error.mockClear();
    const { status } = await answer("a bare string");

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][1]).toMatchObject({ errorName: "string", errorMessage: "a bare string" });
    expect(status).toBe(500);
  });

  it("does not log for a classified refusal — those are the caller's error, not ours", async () => {
    error.mockClear();
    await answer(new JobAuthorizationError());
    await answer(new JobNotFoundError());

    expect(error).not.toHaveBeenCalled();
  });
});
