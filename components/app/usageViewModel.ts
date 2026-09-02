import { formatBytes } from "@/lib/utils/formatBytes";
import { denyMessageFor, type DenyReason } from "@/src/domain/metering/decision";
import { isMeterKey, type MeterKey } from "@/src/domain/metering/meters";

/**
 * The projection between `GET /api/usage` and the usage card.
 *
 * A separate pure module rather than logic inside the component, for two
 * reasons that are not stylistic:
 *
 *  - **It is the layer that decides what a user sees.** "Never expose internal
 *    counter keys" is a rule about output, and a rule about output is only real if
 *    something tests it. Vitest runs with `environment: "node"`, so a `.tsx`
 *    component cannot be rendered here; a pure module can be asserted against
 *    directly. The alternative is a rule that holds until someone interpolates a
 *    meter key into a label.
 *
 *  - **It is where an unknown response shape stops.** The card fetches from an
 *    endpoint that can return a 503, an HTML error page from a proxy, or a body
 *    from a future build with different fields. `parseUsage` treats all of those
 *    as "unavailable" instead of letting `undefined.toFixed` reach the render.
 */

/** Meters worth showing a user, in display order. */
const DISPLAYED_METERS: readonly MeterKey[] = ["server_operations", "server_input_bytes"];

/**
 * The human name for each meter, so the raw key never reaches the DOM.
 *
 * `METERS[key].unit` and `.description` exist, but they are written for an
 * operator ("Server-side tool runs submitted by this owner") and mention an
 * "owner", which is internal vocabulary. These are the user's words for the same
 * quantities.
 */
const METER_LABELS: Record<MeterKey, string> = {
  server_operations: "Heavy operations",
  server_input_bytes: "Upload volume",
  compute_units: "Processing",
  ai_tokens: "AI usage",
};

export interface UsageMeterView {
  /** Stable list key. Deliberately NOT the meter key — see `id` below. */
  id: string;
  label: string;
  /** Pre-formatted for display: "12 of 40" or "1.2 MB of 200 MB". */
  usedLabel: string;
  /**
   * "28 left" — and **null in observe mode**, where nothing is actually
   * withheld.
   *
   * A remaining figure is a statement about what will be refused next. When
   * `mode` is not `enforce`, nothing will be refused, so "100 left" rendered
   * directly above "nothing is blocked yet" told a user two contradictory
   * things and invited them to trust the number. Null means the card omits the
   * line rather than rewording it: there is no honest phrasing of a headroom
   * figure for a ceiling that does not apply.
   */
  remainingLabel: string | null;
  used: number;
  limit: number;
  /** 0–1, clamped. Null when the plan sets no limit for this meter. */
  fraction: number | null;
  /** Bar tone: warns before it blocks, so a ceiling is not a surprise. */
  tone: "info" | "warning" | "danger";
  /**
   * Whether this ceiling can refuse work, restated per meter.
   *
   * Duplicates `UsageView.enforced` on purpose: a meter row is rendered on its
   * own, and a consumer that reads a row without the view around it must not be
   * able to present an observed figure as an enforced one.
   */
  limitKind: "enforced" | "observed";
  resetLabel: string;
}

export interface UsageView {
  planLabel: string;
  /**
   * Whether the limits shown can actually refuse work.
   *
   * In `observe` mode a full bar means "you would have hit the candidate ceiling",
   * not "your next merge is blocked". A card that showed the same wording in both
   * modes would invent a paywall this phase does not have.
   */
  enforced: boolean;
  meters: UsageMeterView[];
  /**
   * The **plan's** per-upload ceiling, pre-formatted.
   *
   * Not the ceiling any individual tool applies: browser tools validate against
   * `MAX_SIZE` (50MB) and each server tool has its own `maxSizeBytes` (20–100MB).
   * This is the account-level bound, which is a different number for a different
   * reason, and the card must say which one it is showing.
   */
  maxFileLabel: string;
  /** True when the server could not read its counters; numbers are then floors. */
  degraded: boolean;
}

/** What the card renders. One shape, so the component has no branching to get wrong. */
export type UsageState =
  | { kind: "loading" }
  /** The endpoint answered with something unusable, or did not answer. */
  | { kind: "unavailable" }
  /** The plan grants no measurable allowance to display (no enforceable meters). */
  | { kind: "empty"; planLabel: string }
  | { kind: "ready"; view: UsageView };

/**
 * Projects a `/api/usage` body, or reports that it could not.
 *
 * Every field is read defensively. The endpoint is ours, but the *deployed*
 * version of it need not match this build — during a rolling deploy it demonstrably
 * does not — and the failure mode of optimistic parsing here is a blank page in an
 * account area, from a widget nobody needs.
 */
export function parseUsage(body: unknown, now: number): UsageState {
  if (!isRecord(body)) return { kind: "unavailable" };

  const planLabel = typeof body.planLabel === "string" && body.planLabel.trim()
    ? body.planLabel.trim()
    : "Current plan";
  const enforced = body.mode === "enforce";
  const rawMeters = Array.isArray(body.meters) ? body.meters : [];

  const meters: UsageMeterView[] = [];
  for (const key of DISPLAYED_METERS) {
    const row = rawMeters.find(
      (m): m is Record<string, unknown> => isRecord(m) && m.meter === key,
    );
    if (!row) continue;
    const used = finite(row.used);
    const limit = finite(row.limit);
    // A non-positive limit means "no allowance defined", not "zero allowed":
    // rendering it as a full bar would tell someone on an unlimited plan that
    // they are out of quota.
    if (limit <= 0) continue;
    const isBytes = key === "server_input_bytes";
    const fmt = (n: number) => (isBytes ? formatBytes(n) : String(Math.round(n)));
    const fraction = Math.max(0, Math.min(1, used / limit));
    meters.push({
      // A synthetic id. The meter key is an internal counter identifier and this
      // value reaches the DOM as a React key, so it is mapped rather than passed
      // through — the label is already unique per row.
      id: `meter-${meters.length}`,
      label: METER_LABELS[key],
      usedLabel: `${fmt(used)} of ${fmt(limit)}`,
      // Clamped at zero: `used` can exceed `limit`, and "-3 remaining" is not a
      // thing anyone needs to read. Null when the ceiling is not enforced — see
      // the field's note.
      remainingLabel: enforced ? `${fmt(Math.max(0, limit - used))} left` : null,
      used,
      limit,
      fraction,
      tone: fraction >= 1 ? "danger" : fraction >= 0.8 ? "warning" : "info",
      limitKind: enforced ? "enforced" : "observed",
      resetLabel: resetLabel(row.resetAt, now),
    });
  }

  if (meters.length === 0) return { kind: "empty", planLabel };

  const maxFileBytes = finite(body.maxFileBytes);
  return {
    kind: "ready",
    view: {
      planLabel,
      enforced,
      meters,
      maxFileLabel: maxFileBytes > 0 ? formatBytes(maxFileBytes) : "—",
      degraded: body.degraded === true,
    },
  };
}

/**
 * "Resets in 3 hours". Future-facing, which is why `relativeTime` in
 * dashboardLogic is not reused: that one renders every future instant as "just
 * now", which for a reset time is the one reading that is always wrong.
 */
function resetLabel(raw: unknown, now: number): string {
  if (typeof raw !== "string") return "";
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "Resets shortly";
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Resets in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Resets in ${days} day${days === 1 ? "" : "s"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Guard for the display list: every displayed meter must be a real meter.
 *
 * Exported so the invariant is checked rather than assumed — a typo in
 * `DISPLAYED_METERS` would otherwise silently render an empty card, which the
 * "empty" state makes look intentional.
 */
export function displayedMeterProblems(): string[] {
  return DISPLAYED_METERS.filter((key) => !isMeterKey(key)).map((key) => `${key}: not a meter`);
}

// ---- quota denial ---------------------------------------------------------

/**
 * The denial reasons a submit route answers with, exhaustive by construction.
 *
 * A `Record<DenyReason, true>` rather than a string array: adding a reason to
 * `src/domain/metering/decision.ts` then fails to compile here until it is listed,
 * so a new refusal cannot silently fall through to the generic error banner.
 */
const DENIAL_REASONS: Record<DenyReason, true> = {
  meter_exhausted: true,
  file_too_large: true,
  too_many_concurrent: true,
};

/**
 * Reads a quota refusal out of a failed submit response, or returns null.
 *
 * Both the status *and* the reason must agree: a 429 from something else (a rate
 * limiter, a proxy) carries no known reason and stays an ordinary error, and a body
 * that claims a reason with a 200 or a 500 is not a quota denial either.
 *
 * This is the only thing the client reads from a refusal body. Plan, remaining
 * allowance and reset time all come from `/api/usage` — see `quotaNoticeView`.
 */
export function readDenialReason(status: number, body: unknown): DenyReason | null {
  if (status !== 429 || !isRecord(body)) return null;
  const reason = body.reason;
  return typeof reason === "string" && reason in DENIAL_REASONS
    ? (reason as DenyReason)
    : null;
}

export interface QuotaNoticeView {
  headline: string;
  /** The refusal sentence. Derived from the reason locally, never from a body. */
  detail: string;
  /** Null when `/api/usage` did not answer: a plan is never guessed. */
  planLabel: string | null;
  /** Null unless a reset is both known and relevant to this reason. */
  resetLabel: string | null;
}

const DENIAL_HEADLINES: Record<DenyReason, string> = {
  meter_exhausted: "You have used your allowance for now",
  file_too_large: "That file is larger than your plan allows",
  too_many_concurrent: "Too many files are processing",
};

/**
 * What the quota panel says.
 *
 * ## Why the reason is mapped locally instead of shown from the response
 *
 * `detail` comes from `denyMessageFor`, the same domain copy the server sends —
 * read from the domain rather than from the response body, so no server-supplied
 * string is ever rendered on this path at all. That closes the "raw exception text
 * reaches the user" question by construction instead of by trusting the route.
 *
 * ## Why the plan and the reset come from `/api/usage`
 *
 * They are authoritative there, per-owner, and already sanitized for display. The
 * alternative — computing "you have 0 of 100 left" from numbers echoed back in the
 * refusal — is a client deciding what someone's quota is, and it is wrong the
 * moment a window rolls over or a second tab spends the allowance. When usage is
 * unavailable, both fields are null and the panel renders without them: a refusal
 * the user can read is worth more than a plan name.
 *
 * ## Why the reset is only shown for an exhausted meter
 *
 * A window reset is the answer to "when can I try again" *only* for a meter. A file
 * that is too large is still too large after midnight, and a concurrency ceiling
 * clears when a job finishes rather than when the window rolls — so quoting a reset
 * for either would be a confident lie.
 */
export function quotaNoticeView(reason: DenyReason, usage: UsageState): QuotaNoticeView {
  const view = usage.kind === "ready" ? usage.view : null;
  const planLabel =
    view?.planLabel ?? (usage.kind === "empty" ? usage.planLabel : null) ?? null;

  // The fullest meter is the one that ran out, so its window is the one that
  // matters. Chosen by fraction rather than by key: the meter identity stays out
  // of this projection entirely.
  const fullest = view?.meters.reduce<UsageMeterView | null>(
    (best, m) => (best === null || (m.fraction ?? 0) > (best.fraction ?? 0) ? m : best),
    null,
  );

  return {
    headline: DENIAL_HEADLINES[reason],
    detail: denyMessageFor(reason),
    planLabel,
    resetLabel:
      reason === "meter_exhausted" && fullest?.resetLabel ? fullest.resetLabel : null,
  };
}
