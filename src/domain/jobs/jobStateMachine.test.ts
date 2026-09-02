import { describe, expect, it } from "vitest";
import type { JobStatus } from "@/src/domain/entities/Job";
import {
  ALLOWED_TRANSITIONS,
  ALL_JOB_STATUSES,
  InvalidJobTransitionError,
  LIFECYCLE_NAME,
  RETRYABLE_FROM,
  TERMINAL_STATUSES,
  assertTransition,
  canPublishResult,
  canRetryTransition,
  canRecoverTransition,
  canTransition,
  isTerminal,
  isTransitionAllowed,
} from "./jobStateMachine";

/**
 * The state machine is the correctness core of the pipeline: "a cancelled job
 * never produces a result" is not a check somewhere in the worker, it is the fact
 * that `cancelled → completed` does not exist. So these tests enumerate the whole
 * 7×7 space rather than sampling it — a transition that is neither asserted legal
 * nor asserted illegal is a transition nobody has decided about.
 */
describe("job state machine — exhaustive transition table", () => {
  const EXPECTED_LEGAL: ReadonlyArray<[JobStatus, JobStatus]> = [
    ["created", "queued"],
    ["created", "cancelled"],
    ["created", "failed"],
    ["queued", "running"],
    ["queued", "cancelled"],
    ["queued", "failed"],
    ["queued", "expired"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["completed", "expired"],
  ];

  const legalKey = new Set(EXPECTED_LEGAL.map(([f, t]) => `${f}->${t}`));

  it("covers every ordered pair of statuses", () => {
    // 7 statuses → 49 ordered pairs, including self-transitions.
    const pairs = ALL_JOB_STATUSES.flatMap((f) =>
      ALL_JOB_STATUSES.map((t) => `${f}->${t}`),
    );
    expect(pairs).toHaveLength(49);
    expect(new Set(pairs).size).toBe(49);
  });

  for (const from of ALL_JOB_STATUSES) {
    for (const to of ALL_JOB_STATUSES) {
      const key = `${from}->${to}`;
      const expected = legalKey.has(key);
      it(`${expected ? "allows" : "rejects"} ${LIFECYCLE_NAME[from]} → ${LIFECYCLE_NAME[to]}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it("rejects every self-transition", () => {
    // A status write that does not change the status is either a no-op the caller
    // should not be issuing or a lost update. Neither should look successful.
    for (const s of ALL_JOB_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("keeps the exported table in sync with the assertions", () => {
    const fromTable = ALL_JOB_STATUSES.flatMap((f) =>
      [...ALLOWED_TRANSITIONS[f]].map((t) => `${f}->${t}`),
    );
    expect(fromTable.sort()).toEqual([...legalKey].sort());
  });
});

describe("job state machine — the four transitions the brief names", () => {
  // Each of these, if allowed, is a specific user-visible lie.
  it("rejects COMPLETED → PROCESSING", () => {
    // Would let a finished job start again and overwrite a result already handed
    // to the user.
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("rejects FAILED → COMPLETED", () => {
    // Would let a job that reported an error later claim success.
    expect(canTransition("failed", "completed")).toBe(false);
  });

  it("rejects CANCELLED → COMPLETED", () => {
    // The load-bearing one: this is what makes "no result after cancellation"
    // structurally impossible rather than conditionally checked.
    expect(canTransition("cancelled", "completed")).toBe(false);
  });

  it("rejects EXPIRED → QUEUED, even as a retry", () => {
    // The staged input is deleted with the retention window, so a revived expired
    // job would run against nothing.
    expect(canTransition("expired", "queued")).toBe(false);
    expect(isTransitionAllowed("expired", "queued", { retry: true })).toBe(false);
  });
});

describe("job state machine — retry", () => {
  it("permits failed → queued and cancelled → queued only with the retry flag", () => {
    for (const from of ["failed", "cancelled"] as const) {
      expect(canTransition(from, "queued")).toBe(false);
      expect(isTransitionAllowed(from, "queued", { retry: true })).toBe(true);
      expect(canRetryTransition(from)).toBe(true);
    }
  });

  it("does not let the retry flag unlock anything else", () => {
    // The flag is a single sanctioned exception, not a bypass. If it widened the
    // table generally, every guarded write in the worker would be guarded in name
    // only.
    for (const from of ALL_JOB_STATUSES) {
      for (const to of ALL_JOB_STATUSES) {
        const withRetry = isTransitionAllowed(from, to, { retry: true });
        const plain = canTransition(from, to);
        const isSanctioned = RETRYABLE_FROM.has(from) && to === "queued";
        if (!isSanctioned) expect(withRetry).toBe(plain);
      }
    }
  });

  it("does not treat completed or expired as retryable origins", () => {
    expect(canRetryTransition("completed")).toBe(false);
    expect(canRetryTransition("expired")).toBe(false);
    expect(canRetryTransition("running")).toBe(false);
  });
});

describe("job state machine — recovery", () => {
  it("permits running → queued only with the recover flag", () => {
    // The stuck-job sweep's single sanctioned move. Without the flag `running` is
    // a dead end towards `queued`, which is exactly why a crashed worker used to
    // strand its job.
    expect(canTransition("running", "queued")).toBe(false);
    expect(isTransitionAllowed("running", "queued", { recover: true })).toBe(true);
    expect(canRecoverTransition("running")).toBe(true);
  });

  it("does not let the recover flag resurrect a terminal job", () => {
    // The structural half of "terminal jobs are never recovered": the sweep asks
    // for `→ queued` and the answer is no, whatever it passes.
    for (const from of ["completed", "failed", "cancelled", "expired"] as const) {
      expect(canRecoverTransition(from)).toBe(false);
      expect(isTransitionAllowed(from, "queued", { recover: true })).toBe(false);
    }
  });

  it("does not let the recover flag unlock anything else", () => {
    for (const from of ALL_JOB_STATUSES) {
      for (const to of ALL_JOB_STATUSES) {
        const withRecover = isTransitionAllowed(from, to, { recover: true });
        const plain = canTransition(from, to);
        const isSanctioned = from === "running" && to === "queued";
        if (!isSanctioned) expect(withRecover).toBe(plain);
      }
    }
  });

  it("keeps recovery separate from retry", () => {
    // A user pressing Retry must never requeue a job a live worker is holding, and
    // an automatic recovery must never revive a job the user chose to abandon.
    // Two flags rather than one is what keeps both true.
    expect(isTransitionAllowed("running", "queued", { retry: true })).toBe(false);
    expect(isTransitionAllowed("failed", "queued", { recover: true })).toBe(false);
    expect(canRetryTransition("running")).toBe(false);
    expect(canRecoverTransition("failed")).toBe(false);
  });
});

describe("job state machine — terminality and result publication", () => {
  it("treats exactly completed, failed, cancelled and expired as terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "expired",
      "failed",
    ]);
    for (const s of ALL_JOB_STATUSES) {
      expect(isTerminal(s)).toBe(TERMINAL_STATUSES.has(s));
    }
  });

  it("allows a result to be published only from completed", () => {
    for (const s of ALL_JOB_STATUSES) {
      expect(canPublishResult(s)).toBe(s === "completed");
    }
  });

  it("leaves failed and cancelled with no outgoing transitions at all", () => {
    // Not even to `expired`: there is no output to expire, and re-marking a
    // failed job would move its finishedAt.
    expect(ALLOWED_TRANSITIONS.failed.size).toBe(0);
    expect(ALLOWED_TRANSITIONS.cancelled.size).toBe(0);
  });
});

describe("assertTransition", () => {
  it("passes silently for a legal move", () => {
    expect(() => assertTransition("queued", "running")).not.toThrow();
  });

  it("throws InvalidJobTransitionError carrying both endpoints", () => {
    try {
      assertTransition("cancelled", "completed");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidJobTransitionError);
      const e = err as InvalidJobTransitionError;
      expect(e.from).toBe("cancelled");
      expect(e.to).toBe("completed");
      // The message uses lifecycle names, so an operator reading a log sees the
      // vocabulary the brief and the UI use, not the persisted string.
      expect(e.message).toContain("CANCELLED");
      expect(e.message).toContain("COMPLETED");
    }
  });

  it("honours the retry flag", () => {
    expect(() => assertTransition("failed", "queued")).toThrow(InvalidJobTransitionError);
    expect(() => assertTransition("failed", "queued", { retry: true })).not.toThrow();
  });

  it("honours the recover flag", () => {
    expect(() => assertTransition("running", "queued")).toThrow(InvalidJobTransitionError);
    expect(() => assertTransition("running", "queued", { recover: true })).not.toThrow();
  });
});

describe("lifecycle naming", () => {
  it("names every status, and maps running to PROCESSING", () => {
    for (const s of ALL_JOB_STATUSES) {
      expect(LIFECYCLE_NAME[s]).toMatch(/^[A-Z]+$/);
    }
    // The brief's lifecycle word is PROCESSING; the persisted value stays
    // `running` so existing rows and adapters are untouched. This mapping is the
    // only place the two vocabularies meet.
    expect(LIFECYCLE_NAME.running).toBe("PROCESSING");
  });
});
