import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_METER_KEYS } from "@/src/domain/metering/meters";
import { displayedMeterProblems, parseUsage } from "./usageViewModel";

/**
 * What the usage card is allowed to show a user.
 *
 * Vitest runs with `environment: "node"`, so the component itself cannot be
 * rendered. The projection is therefore the layer under test — which is why the
 * projection exists as its own module: it is the layer where "never show an
 * internal counter key" and "never crash on an unexpected body" are decided, and
 * both are properties that need a test rather than a convention.
 *
 * The source-text block at the end covers the parts that only exist in the
 * `.tsx`: that failure is caught, that the fetch is not cached, and that nothing
 * about a tool run depends on any of it.
 */

const NOW = Date.parse("2026-03-15T12:00:00.000Z");

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: "free",
    planLabel: "Free",
    mode: "observe",
    maxFileBytes: 25 * 1024 * 1024,
    maxConcurrentJobs: 2,
    activeOperations: 0,
    meters: [
      {
        meter: "server_operations",
        unit: "operations",
        window: "day",
        used: 12,
        limit: 40,
        remaining: 28,
        resetAt: "2026-03-16T00:00:00.000Z",
      },
      {
        meter: "server_input_bytes",
        unit: "bytes",
        window: "day",
        used: 5 * 1024 * 1024,
        limit: 200 * 1024 * 1024,
        remaining: 195 * 1024 * 1024,
        resetAt: "2026-03-16T00:00:00.000Z",
      },
    ],
    degraded: false,
    ...overrides,
  };
}

describe("projection", () => {
  it("shows plan, allowance, remainder and reset", () => {
    const state = parseUsage(body(), NOW);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.view.planLabel).toBe("Free");
    expect(state.view.meters[0]?.label).toBe("Heavy operations");
    expect(state.view.meters[0]?.usedLabel).toBe("12 of 40");
    // Null, because the default body is `mode: "observe"`. See the headroom test
    // below: "28 left" is a claim only an enforced ceiling can make.
    expect(state.view.meters[0]?.remainingLabel).toBeNull();
    expect(state.view.meters[0]?.resetLabel).toBe("Resets in 12 hours");
    expect(state.view.meters[1]?.usedLabel).toBe("5 MB of 200 MB");
    expect(state.view.maxFileLabel).toBe("25 MB");
  });

  it("states headroom only when the ceiling is enforced", () => {
    // The recorded defect: "Heavy operations 0 of 100" and "100 left" sat
    // directly under copy saying the allowances were being measured, not
    // applied. "100 left" is a statement about what will be refused at 100, and
    // in observe mode nothing is refused — so there is no honest wording for it
    // and the line is omitted instead of reworded.
    const observed = readyView(parseUsage(body({ mode: "observe" }), NOW)).meters[0];
    expect(observed?.remainingLabel).toBeNull();
    expect(observed?.limitKind).toBe("observed");
    // Not vacuous: the same figure IS stated once a deployment turns limits on.
    const enforced = readyView(parseUsage(body({ mode: "enforce" }), NOW)).meters[0];
    expect(enforced?.remainingLabel).toBe("28 left");
    expect(enforced?.limitKind).toBe("enforced");
    // The used-of-limit figure is measured either way and stays in both modes.
    expect(observed?.usedLabel).toBe("12 of 40");
    expect(enforced?.usedLabel).toBe("12 of 40");
  });

  it("marks observe mode as monitoring, not as a limit", () => {
    expect(readyView(parseUsage(body({ mode: "observe" }), NOW)).enforced).toBe(false);
    expect(readyView(parseUsage(body({ mode: "off" }), NOW)).enforced).toBe(false);
    expect(readyView(parseUsage(body({ mode: "enforce" }), NOW)).enforced).toBe(true);
  });

  it("warns before it blocks", () => {
    const meters = [{ ...(body().meters as Record<string, unknown>[])[0], used: 34, limit: 40 }];
    expect(readyView(parseUsage(body({ meters }), NOW)).meters[0]?.tone).toBe("warning");
  });

  it("clamps an overage instead of reporting a negative remainder", () => {
    // An overage is reachable in observe mode, where the ceiling records but does
    // not refuse — and then survives the switch to enforce, which is the mode
    // that has a remainder to state at all.
    const meters = [{ ...(body().meters as Record<string, unknown>[])[0], used: 55, limit: 40 }];
    const meter = readyView(parseUsage(body({ meters, mode: "enforce" }), NOW)).meters[0];
    expect(meter?.remainingLabel).toBe("0 left");
    expect(meter?.fraction).toBe(1);
    expect(meter?.tone).toBe("danger");
  });

  it("omits a meter with no defined allowance rather than showing it as full", () => {
    const meters = [{ ...(body().meters as Record<string, unknown>[])[0], limit: 0 }];
    // Only server_input_bytes remains; an unlimited plan must not read as
    // "out of quota".
    expect(readyView(parseUsage(body({ meters: [meters[0], (body().meters as unknown[])[1]] }), NOW)).meters)
      .toHaveLength(1);
  });

  it("passes the degraded flag through", () => {
    expect(readyView(parseUsage(body({ degraded: true }), NOW)).degraded).toBe(true);
  });
});

describe("nothing internal reaches the user", () => {
  it("exposes no meter key, owner id, or counter identifier", () => {
    const serialized = JSON.stringify(
      parseUsage(
        body({
          ownerId: "user_01HZX",
          subjectHash: "SUBJECT-SENTINEL",
          meters: [
            {
              ...(body().meters as Record<string, unknown>[])[0],
              counterKey: "user|user_01HZX|server_operations|1773",
            },
          ],
        }),
        NOW,
      ),
    );
    for (const key of ALL_METER_KEYS) expect(serialized).not.toContain(key);
    expect(serialized).not.toContain("user_01HZX");
    expect(serialized).not.toContain("SUBJECT-SENTINEL");
    expect(serialized).not.toContain("ownerId");
    expect(serialized).not.toContain("counterKey");
    // Not vacuous: the projection did produce the row those keys were attached to.
    expect(serialized).toContain("Heavy operations");
  });

  it("displays only meters that exist", () => {
    expect(displayedMeterProblems()).toEqual([]);
  });
});

describe("unusable responses", () => {
  it("reports unavailable for a body that is not an object", () => {
    for (const value of [null, undefined, 42, "<!doctype html>", [1, 2]]) {
      expect(parseUsage(value, NOW).kind).toBe("unavailable");
    }
  });

  it("reports empty when no displayable meter has an allowance", () => {
    const state = parseUsage(body({ meters: [] }), NOW);
    expect(state.kind).toBe("empty");
    if (state.kind === "empty") expect(state.planLabel).toBe("Free");
  });

  it("ignores meters it does not display", () => {
    const state = parseUsage(
      body({ meters: [{ meter: "ai_tokens", used: 5, limit: 100, resetAt: "2026-04-01T00:00:00.000Z" }] }),
      NOW,
    );
    expect(state.kind).toBe("empty");
  });

  it("survives missing and malformed fields without throwing", () => {
    const state = parseUsage(
      { planLabel: "  ", meters: [{ meter: "server_operations", used: "lots", limit: 40, resetAt: 12345 }] },
      NOW,
    );
    const view = readyView(state);
    expect(view.planLabel).toBe("Current plan");
    expect(view.meters[0]?.usedLabel).toBe("0 of 40");
    // An unreadable timestamp yields no label rather than "Invalid Date".
    expect(view.meters[0]?.resetLabel).toBe("");
    expect(view.maxFileLabel).toBe("—");
  });

  it("does not render a past reset as a future one", () => {
    const meters = [
      { ...(body().meters as Record<string, unknown>[])[0], resetAt: "2026-03-15T11:00:00.000Z" },
    ];
    expect(readyView(parseUsage(body({ meters }), NOW)).meters[0]?.resetLabel).toBe("Resets shortly");
  });
});

describe("the card itself", () => {
  const src = readFileSync(path.join(process.cwd(), "components/app/UsageCard.tsx"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");

  it("cannot fail a tool: every fetch path ends in a state, not a throw", () => {
    expect(code).toContain("catch");
    expect(code).toContain('kind: "unavailable"');
    // A non-2xx is handled explicitly; `res.json()` on an error page would throw
    // into the catch, but only the catch keeps that off the screen.
    expect(code).toContain("res.ok");
    expect(code).toMatch(/AbortController/);
  });

  it("does not read a cached allowance", () => {
    expect(code).toContain('cache: "no-store"');
  });

  it("does the numbers in the tested module, not in markup", () => {
    // Formatting in the component is formatting no test can reach.
    expect(code).toContain("parseUsage");
    expect(code).not.toContain("toFixed");
    expect(code).not.toContain("formatBytes");
  });

  it("says in words what monitoring mode means, not just in a badge", () => {
    // A `Monitoring` badge next to a full bar is a label the user has to
    // interpret; the wrong interpretation is "I have been throttled". The
    // sentence is gated on the same `enforced` flag as the badge, so a
    // deployment that turns limits on stops claiming nothing is blocked.
    expect(code).toContain("<StatusBadge tone=\"neutral\">Monitoring</StatusBadge>");
    expect(code).toContain("nothing is blocked yet");
    expect(code).toMatch(/\{!state\.view\.enforced && \(/);
  });

  it("omits the headroom line rather than rendering a null", () => {
    // `remainingLabel` is nullable now. Rendered unguarded it reads "null" on
    // screen in exactly the mode the nullability exists to serve.
    expect(code).toContain('{meter.remainingLabel ?? ""}');
    expect(code).not.toMatch(/\{meter\.remainingLabel\}/);
  });

  it("says which ceiling the file-size figure is", () => {
    // The recorded ambiguity: the homepage upload said 50MB and this card said
    // "Largest file per upload 100MB". Both were true of different things — the
    // hero's tool limit and the plan ceiling — and neither said which.
    expect(code).toContain("Largest file this plan allows per upload");
    expect(code).toContain("each upload box states its own limit");
  });

  it("imports nothing from the server-side metering stack", () => {
    // A client component that reaches into the DI container or a repository would
    // pull server code — and any secret it reads — toward the browser bundle.
    expect(code).not.toContain("@/src/application/di");
    expect(code).not.toContain("UsageRepository");
    expect(code).not.toContain("ANALYTICS_SUBJECT_SECRET");
  });
});

function readyView(state: ReturnType<typeof parseUsage>) {
  if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
  return state.view;
}
