/**
 * WHAT is counted. One authoritative list, for every consumer.
 *
 * A meter is a named quantity that accumulates against an owner over a window.
 * Everything else in this directory — cost profiles, plan entitlements, the
 * limit decision, the counters table — keys off this union, so a meter cannot be
 * invented in one place and go unrecognized in another.
 *
 * The `enforceable` flag is the honest part. `compute_units` is recorded because
 * "how much processing different tools consume" is a question the product needs
 * answered, but it is a *derived* number: blocking someone on a derived number
 * they cannot see or predict is a bad experience and an unfalsifiable bill. Only
 * meters a user could reasonably anticipate — a count of operations, the bytes
 * they chose to upload — are eligible to deny work.
 *
 * `ai_tokens` is declared with no producer anywhere in the codebase. That is
 * deliberate: the point of this phase is to prepare for AI usage without adding
 * AI, and a meter that exists in the vocabulary is one that a future AI feature
 * plugs into rather than one that arrives alongside a second metering system.
 * A guard test asserts no plan enforces it, so it cannot silently start
 * gating anything before there is something to gate.
 */
export type MeterKey =
  | "server_operations"
  | "server_input_bytes"
  | "compute_units"
  | "ai_tokens";

export const ALL_METER_KEYS: readonly MeterKey[] = [
  "server_operations",
  "server_input_bytes",
  "compute_units",
  "ai_tokens",
];

/**
 * The reset cadence of a meter's allowance.
 *
 * Both windows are UTC-aligned (see ./periods.ts) rather than rolling. A rolling
 * window needs the full event history to evaluate; a fixed window needs one
 * counter row, which is what makes an admission check a single indexed read
 * instead of a scan.
 */
export type MeterWindow = "day" | "month";

export interface MeterDefinition {
  key: MeterKey;
  /** Human-readable unit, for the allowance snapshot and the admin surface. */
  unit: string;
  window: MeterWindow;
  /** Whether this meter may ever deny an operation. See the note above. */
  enforceable: boolean;
  description: string;
}

export const METERS: Record<MeterKey, MeterDefinition> = {
  server_operations: {
    key: "server_operations",
    unit: "operations",
    window: "day",
    enforceable: true,
    description: "Server-side tool runs submitted by this owner.",
  },
  server_input_bytes: {
    key: "server_input_bytes",
    unit: "bytes",
    window: "day",
    enforceable: true,
    description: "Total bytes uploaded for server-side processing.",
  },
  compute_units: {
    key: "compute_units",
    unit: "units",
    window: "month",
    enforceable: false,
    description: "Derived cost of processing work; recorded for reporting only.",
  },
  ai_tokens: {
    key: "ai_tokens",
    unit: "tokens",
    window: "month",
    enforceable: false,
    description: "Reserved for future AI features. Nothing produces this today.",
  },
};

/** Narrowing guard for values arriving from the database or an HTTP body. */
export function isMeterKey(value: unknown): value is MeterKey {
  return typeof value === "string" && (ALL_METER_KEYS as readonly string[]).includes(value);
}

/** The meters that may deny an operation. Derived, never hand-listed. */
export const ENFORCEABLE_METERS: readonly MeterKey[] = ALL_METER_KEYS.filter(
  (k) => METERS[k].enforceable,
);

/**
 * Self-check: every key in the union has a definition, and every definition is
 * filed under its own key. Exported so the invariant lives beside the table it
 * constrains, matching `executionPolicyDisagreements()` in
 * lib/tools/executionPolicy.ts.
 */
export function meterTableProblems(): string[] {
  const problems: string[] = [];
  for (const key of ALL_METER_KEYS) {
    const def = METERS[key];
    if (!def) {
      problems.push(`${key}: declared in ALL_METER_KEYS but missing from METERS`);
      continue;
    }
    if (def.key !== key) problems.push(`${key}: filed under key "${def.key}"`);
    if (!def.unit.trim()) problems.push(`${key}: missing unit`);
    if (!def.description.trim()) problems.push(`${key}: missing description`);
  }
  for (const key of Object.keys(METERS)) {
    if (!(ALL_METER_KEYS as readonly string[]).includes(key)) {
      problems.push(`${key}: present in METERS but not in ALL_METER_KEYS`);
    }
  }
  return problems;
}
