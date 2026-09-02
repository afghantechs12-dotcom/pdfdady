import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseUsage,
  quotaNoticeView,
  readDenialReason,
} from "@/components/app/usageViewModel";
import { ALL_METER_KEYS } from "@/src/domain/metering/meters";

/**
 * What a user sees when a submission is refused for quota.
 *
 * Vitest runs with `environment: "node"`, so the panel itself cannot be rendered
 * here — which is why the two decisions worth testing live in the pure projection:
 * what is read out of a refusal (`readDenialReason`) and what is said about it
 * (`quotaNoticeView`). The source-text block covers what only exists in the
 * `.tsx`: where the plan comes from, and that a billing or usage failure costs the
 * panel a line rather than costing the user their PDF.
 */

const NOW = Date.parse("2026-03-15T12:00:00.000Z");

function usageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: "free",
    planLabel: "Free",
    mode: "enforce",
    maxFileBytes: 100 * 1024 * 1024,
    meters: [
      {
        meter: "server_operations",
        unit: "operations",
        window: "day",
        used: 100,
        limit: 100,
        remaining: 0,
        resetAt: new Date(NOW + 3 * 3_600_000).toISOString(),
      },
      {
        meter: "server_input_bytes",
        unit: "bytes",
        window: "day",
        used: 1024,
        limit: 5 * 1024 * 1024 * 1024,
        remaining: 1,
        resetAt: new Date(NOW + 3 * 3_600_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

describe("recognising a refusal", () => {
  it("reads the reason from a 429 that carries a known one", () => {
    expect(readDenialReason(429, { error: "…", reason: "meter_exhausted" })).toBe(
      "meter_exhausted",
    );
    expect(readDenialReason(429, { reason: "file_too_large" })).toBe("file_too_large");
    expect(readDenialReason(429, { reason: "too_many_concurrent" })).toBe(
      "too_many_concurrent",
    );
  });

  it("ignores a 429 from anything that is not the quota system", () => {
    // The rate limiter and a proxy both answer 429. Neither is a quota refusal, and
    // showing someone their plan because a proxy shed load would be a lie.
    expect(readDenialReason(429, { error: "Too many requests." })).toBeNull();
    expect(readDenialReason(429, { reason: "rate_limited" })).toBeNull();
    expect(readDenialReason(429, null)).toBeNull();
    expect(readDenialReason(429, "Too Many Requests")).toBeNull();
  });

  it("ignores a claimed reason on any other status", () => {
    // A body cannot promote itself into a quota denial: the status has to agree.
    expect(readDenialReason(500, { reason: "meter_exhausted" })).toBeNull();
    expect(readDenialReason(400, { reason: "file_too_large" })).toBeNull();
    expect(readDenialReason(200, { reason: "meter_exhausted" })).toBeNull();
  });
});

describe("what the panel says", () => {
  it("names the plan and the reset from the usage projection", () => {
    const view = quotaNoticeView("meter_exhausted", parseUsage(usageBody(), NOW));
    expect(view.planLabel).toBe("Free");
    expect(view.resetLabel).toBe("Resets in 3 hours");
    expect(view.headline).toBe("You have used your allowance for now");
    expect(view.detail).toContain("usage limit");
  });

  it("quotes the window of the meter that actually ran out", () => {
    // Two meters, two windows: the fullest one is the one that refused the work, so
    // its reset is the answer to "when can I try again". Picked by fraction, so the
    // meter's identity never enters the projection.
    const body = usageBody({
      meters: [
        {
          meter: "server_operations",
          used: 3,
          limit: 100,
          resetAt: new Date(NOW + 20 * 3_600_000).toISOString(),
        },
        {
          meter: "server_input_bytes",
          used: 5 * 1024 * 1024 * 1024,
          limit: 5 * 1024 * 1024 * 1024,
          resetAt: new Date(NOW + 2 * 3_600_000).toISOString(),
        },
      ],
    });
    expect(quotaNoticeView("meter_exhausted", parseUsage(body, NOW)).resetLabel).toBe(
      "Resets in 2 hours",
    );
  });

  it("quotes no reset for a limit a reset does not lift", () => {
    // A file that is too large is still too large after midnight, and a concurrency
    // ceiling clears when a job finishes rather than when the window rolls.
    const usage = parseUsage(usageBody(), NOW);
    expect(quotaNoticeView("file_too_large", usage).resetLabel).toBeNull();
    expect(quotaNoticeView("too_many_concurrent", usage).resetLabel).toBeNull();
    expect(quotaNoticeView("file_too_large", usage).headline).toContain("larger than");
  });

  it("guesses no plan when usage is unavailable, and still says why the work stopped", () => {
    // The billing/usage read failing must not cost the user the explanation.
    for (const state of [{ kind: "unavailable" } as const, { kind: "loading" } as const]) {
      const view = quotaNoticeView("meter_exhausted", state);
      expect(view.planLabel).toBeNull();
      expect(view.resetLabel).toBeNull();
      expect(view.detail).toContain("usage limit");
      expect(view.headline).toBeTruthy();
    }
  });

  it("uses the plan from an allowance-free plan too", () => {
    const view = quotaNoticeView("too_many_concurrent", parseUsage(usageBody({ meters: [] }), NOW));
    expect(view.planLabel).toBe("Free");
  });

  it("never puts a meter key, a counter, or an owner in front of a user", () => {
    // The whole reason the 429 body was narrowed: a refusal explains itself in
    // words, and the numbers stay behind `/api/usage`.
    const usage = parseUsage(usageBody(), NOW);
    for (const reason of ["meter_exhausted", "file_too_large", "too_many_concurrent"] as const) {
      const text = Object.values(quotaNoticeView(reason, usage)).join(" ");
      for (const key of ALL_METER_KEYS) expect(text).not.toContain(key);
      expect(text).not.toMatch(/owner|ownerId|counter|\b100\b/i);
    }
  });
});

describe("the panel itself", () => {
  const code = readFileSync(
    path.join(process.cwd(), "components/tools/QuotaNotice.tsx"),
    "utf8",
  );

  it("reads the plan from the server's usage projection, not from the refusal", () => {
    expect(code).toContain('fetch("/api/usage"');
    expect(code).toContain("cache: \"no-store\"");
    expect(code).toContain("parseUsage");
    // Nothing but the reason is threaded in from the failed submit.
    expect(code).toMatch(/\{ reason \}: \{ reason: DenyReason \}/);
  });

  it("survives a usage endpoint that does not answer", () => {
    expect(code).toContain("} catch {");
    expect(code).toContain('setUsage({ kind: "unavailable" })');
  });

  it("delegates upgrade eligibility rather than deciding it", () => {
    // `ProUpgradeAction` reads its own summary and renders nothing when the
    // deployment cannot sell Pro, so a deployment without Stripe shows a refusal
    // with no dead button — and a billing outage cannot throw into this panel.
    expect(code).toContain("<ProUpgradeAction");
    expect(code).not.toContain("/api/billing/checkout");
    expect(code).not.toContain("price");
  });

  it("computes no quota arithmetic of its own", () => {
    // A client that subtracts its own remaining allowance is wrong the moment a
    // window rolls over or a second tab spends it.
    expect(code).not.toMatch(/used\s*[-+<>]|limit\s*[-+<>]|remaining\s*[-+]/);
    expect(code).not.toContain("localStorage");
  });
});

describe("the runners that submit server work", () => {
  /** The two surfaces that submit server work, and the state each keys off. */
  const renderers = {
    "components/tools/runners/ServerToolRunner.tsx": "denial",
    "components/tools/runners/PipelineToolRunner.tsx": "submitDenial",
  } as const;

  it("classify a refusal through the one shared reader", () => {
    for (const file of ["components/tools/runners/ServerToolRunner.tsx", "hooks/useProcessingJob.ts"]) {
      const code = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(code).toContain("readDenialReason(res.status,");
    }
  });

  it("show the denial panel instead of the banner, never both", () => {
    for (const [file, field] of Object.entries(renderers)) {
      const code = readFileSync(path.join(process.cwd(), file), "utf8");
      // Either the panel or the banner renders — a user reading both would be told
      // twice, once without the plan.
      expect(code).toMatch(new RegExp(`${field}\\s*(&&|\\?)`));
      expect(code).toMatch(new RegExp(`!${field}\\s*&&|${field}\\s*\\?`));
    }
  });

  it("clear the refusal when new work starts, so a stale panel cannot linger", () => {
    const runner = readFileSync(
      path.join(process.cwd(), "components/tools/runners/ServerToolRunner.tsx"),
      "utf8",
    );
    expect(runner).toContain("setDenial(null)");
    const hook = readFileSync(path.join(process.cwd(), "hooks/useProcessingJob.ts"), "utf8");
    expect(hook).toContain("submitDenial: null");
  });

  it("leave the browser-only tools alone", () => {
    // A local tool never reaches the server and is never metered, so a quota panel
    // has no business in one. This is the check that catches a well-meaning
    // "add it everywhere" edit.
    const local = ["MergeTool", "SplitTool", "CropTool", "AnnotateTool", "RemoveMetadataTool"];
    for (const name of local) {
      const code = readFileSync(
        path.join(process.cwd(), `components/tools/runners/${name}.tsx`),
        "utf8",
      );
      expect(code).not.toContain("QuotaNotice");
    }
  });
});
