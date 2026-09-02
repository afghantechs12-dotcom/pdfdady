import { pricingPlans } from "@/data/pricing";
import { serverToolConfig } from "@/data/serverToolConfig";
import { ALL_METER_KEYS, METERS, type MeterKey } from "./meters";

/**
 * WHICH limits apply to whom. One authoritative table.
 *
 * Four plans, and `guest` is the one that is not on the pricing page: an
 * anonymous visitor is a real actor with a real allowance, not an absence of
 * one. Modelling them as a plan means the limit decision has a single shape for
 * everyone, instead of a special "no plan" branch that historically becomes the
 * branch nobody enforces.
 *
 * ── The calibration rule that makes this shippable ──────────────────────────
 *
 * `data/pricing.ts` currently promises the free plan "Every PDF tool that is
 * available today". Any limit that stops a free user doing something they can do
 * right now would make that sentence false, and shipping a quiet regression
 * behind a metering phase is exactly the kind of change that erodes trust in the
 * numbers this phase is meant to produce.
 *
 * So the numbers below are calibrated as *headroom*, not as a paywall:
 *
 *  - `maxFileBytes` for `guest` and `free` is at least the largest per-tool
 *    `maxSizeBytes` in `serverToolConfig` (100MB today). A guard test asserts
 *    this, so lowering it is a deliberate, visible act — not a side effect of
 *    tuning a constant. Per-tool limits stay authoritative and stricter.
 *  - The daily meters are set well above what an ordinary session consumes; they
 *    are abuse ceilings, not product gates.
 *  - `pro` and `business` are higher because `data/pricing.ts` advertises
 *    "Larger file size limits" for Pro. The entitlement table has to be able to
 *    honour that copy the day billing arrives, or the copy becomes the fiction.
 *
 * And none of it is applied yet: `UsageMeteringService` runs in observe mode by
 * default, so these numbers are being *measured against* before they are
 * enforced. That order is the point — calibrating a limit from real usage is
 * possible, guessing one and enforcing it immediately is not.
 */
export type PlanId = "guest" | "free" | "pro" | "business";

export const ALL_PLAN_IDS: readonly PlanId[] = ["guest", "free", "pro", "business"];

export interface PlanLimits {
  id: PlanId;
  /** Shown in the allowance snapshot; not marketing copy. */
  label: string;
  /**
   * Largest single input accepted. Per-tool `maxSizeBytes` still applies and is
   * usually stricter — this is the plan-level ceiling above it, not a licence to
   * exceed it.
   */
  maxFileBytes: number;
  /** Simultaneous non-terminal server jobs. Bounds queue monopolization. */
  maxConcurrentJobs: number;
  /** Per-window allowance per meter. An absent meter is unlimited on this plan. */
  meters: Partial<Record<MeterKey, number>>;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLAN_ENTITLEMENTS: Record<PlanId, PlanLimits> = {
  guest: {
    id: "guest",
    label: "Guest",
    // Matches free: an anonymous visitor using a browser tool is the product's
    // front door, and metering must not make that door narrower than it is now.
    maxFileBytes: 100 * MB,
    maxConcurrentJobs: 2,
    meters: {
      server_operations: 30,
      server_input_bytes: 2 * GB,
      // compute_units is recorded for every actor but capped for nobody — it is
      // not enforceable (see METERS), so listing a number here would be a limit
      // that never applies and therefore a lie in the table.
    },
  },
  free: {
    id: "free",
    label: "Free",
    maxFileBytes: 100 * MB,
    maxConcurrentJobs: 3,
    meters: {
      server_operations: 100,
      server_input_bytes: 5 * GB,
    },
  },
  pro: {
    id: "pro",
    label: "Pro",
    // "Larger file size limits" is on the Pro card in data/pricing.ts.
    maxFileBytes: 500 * MB,
    maxConcurrentJobs: 10,
    meters: {
      server_operations: 2000,
      server_input_bytes: 100 * GB,
    },
  },
  business: {
    id: "business",
    label: "Business",
    maxFileBytes: 2 * GB,
    maxConcurrentJobs: 25,
    meters: {
      server_operations: 20000,
      server_input_bytes: 1024 * GB,
    },
  },
};

/** The plan every unrecognized actor falls back to. Never the most generous. */
export const DEFAULT_PLAN_ID: PlanId = "free";

/** The plan an anonymous visitor gets. */
export const GUEST_PLAN_ID: PlanId = "guest";

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (ALL_PLAN_IDS as readonly string[]).includes(value);
}

/**
 * Coerces a stored plan string into a known plan.
 *
 * `Organization.plan` is a free-text column, so it can hold anything a past
 * migration or an admin wrote. An unknown value resolves to `free` rather than
 * throwing: a typo in a plan column must not make a user's tools stop working,
 * and it must not silently grant Business either.
 */
export function toPlanId(value: unknown): PlanId {
  return isPlanId(value) ? value : DEFAULT_PLAN_ID;
}

export function planLimitsFor(id: PlanId): PlanLimits {
  return PLAN_ENTITLEMENTS[id] ?? PLAN_ENTITLEMENTS[DEFAULT_PLAN_ID];
}

/** The allowance for one meter on one plan, or null when unlimited. */
export function meterLimitFor(id: PlanId, meter: MeterKey): number | null {
  const limit = planLimitsFor(id).meters[meter];
  return typeof limit === "number" ? limit : null;
}

/** The largest per-tool upload limit currently configured. Derived, not typed in. */
export function largestConfiguredToolSizeBytes(): number {
  const sizes = Object.values(serverToolConfig).map((c) => c.maxSizeBytes);
  return sizes.length ? Math.max(...sizes) : 0;
}

/**
 * Self-check across three tables: this one, `data/pricing.ts` and `METERS`.
 *
 * The non-regression assertion is the important one. Everything else here
 * catches a typo; that one catches a product regression — a free-tier ceiling
 * quietly set below what the tools already accept, which would break the
 * promise on the pricing page while every test still passed.
 */
export function entitlementPricingGaps(): string[] {
  const problems: string[] = [];

  for (const plan of pricingPlans) {
    if (!isPlanId(plan.id)) {
      problems.push(`pricing plan "${plan.id}" has no entry in PLAN_ENTITLEMENTS`);
    }
  }

  const pricingIds = new Set(pricingPlans.map((p) => p.id));
  for (const id of ALL_PLAN_IDS) {
    // `guest` is intentionally absent from the pricing page — nobody buys it.
    if (id !== GUEST_PLAN_ID && !pricingIds.has(id)) {
      problems.push(`plan "${id}" has entitlements but is not on the pricing page`);
    }
  }

  for (const id of ALL_PLAN_IDS) {
    const limits = PLAN_ENTITLEMENTS[id];
    if (!limits) {
      problems.push(`${id}: declared in ALL_PLAN_IDS but missing from PLAN_ENTITLEMENTS`);
      continue;
    }
    if (limits.id !== id) problems.push(`${id}: filed under id "${limits.id}"`);
    if (limits.maxConcurrentJobs < 1) {
      problems.push(`${id}: maxConcurrentJobs must allow at least one job`);
    }
    for (const [meter, limit] of Object.entries(limits.meters)) {
      if (!(ALL_METER_KEYS as readonly string[]).includes(meter)) {
        problems.push(`${id}: allowance for unknown meter "${meter}"`);
        continue;
      }
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        problems.push(`${id}: allowance for "${meter}" must be a positive number`);
      }
      if (!METERS[meter as MeterKey]?.enforceable) {
        // A cap on a non-enforceable meter can never fire, so it reads as a
        // limit while being decoration. Either the meter becomes enforceable or
        // the cap comes out.
        problems.push(
          `${id}: allowance set for non-enforceable meter "${meter}" — it would never apply`,
        );
      }
    }
  }

  // The non-regression rule.
  const largestTool = largestConfiguredToolSizeBytes();
  for (const id of [GUEST_PLAN_ID, "free"] as const) {
    const limits = PLAN_ENTITLEMENTS[id];
    if (limits && limits.maxFileBytes < largestTool) {
      problems.push(
        `${id}: maxFileBytes (${limits.maxFileBytes}) is below the largest configured tool limit (${largestTool}) — enforcing this would reject a file the product accepts today`,
      );
    }
  }

  return problems;
}
