import type { ILogger } from "@/src/application/ports/Logger";
import type {
  CounterIncrement,
  CounterScope,
  IUsageRepository,
  UsageEventRecord,
  UsageOwnerType,
} from "@/src/application/ports/metering/UsageRepository";
import type { IEntitlementProvider } from "@/src/application/ports/metering/EntitlementProvider";
import { ANALYTICS_EVENTS, sanitizeEventProperties } from "@/src/domain/metering/events";
import {
  evaluateLimits,
  shouldBlock,
  isLimitMode,
  isReportableDenial,
  type LimitDecision,
  type LimitMode,
} from "@/src/domain/metering/decision";
import { ENFORCEABLE_METERS, METERS, type MeterKey } from "@/src/domain/metering/meters";
import { periodBoundsFor, type PeriodBounds } from "@/src/domain/metering/periods";
import {
  DEFAULT_PLAN_ID,
  meterLimitFor,
  planLimitsFor,
  type PlanId,
} from "@/src/domain/metering/plans";
import { isServerCosted, measureCostUnits } from "@/src/domain/metering/cost";
import { sizeBucket } from "./ProcessingUsageRecorder";
import type { ToolExecutionMode } from "@/lib/tools/executionPolicy";
import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";

/**
 * The one service that admits, reserves, and settles server-side usage.
 *
 * Everything it decides comes from the pure modules in `src/domain/metering`:
 * `plans` says what an actor is entitled to, `decision` says whether an
 * operation is allowed, `periods` says which window a counter belongs to, and
 * `cost` says what a run costs. There is deliberately no second opinion here —
 * this class supplies I/O (a plan lookup, counter reads, counter writes, a
 * ledger row) and orders the steps. A limit re-derived in this file would be a
 * limit that can disagree with the one the tests cover.
 *
 * ── Why reservation, and why it is increment-first ──────────────────────────
 *
 * The obvious admission check — read the counter, compare it to the limit,
 * proceed — is wrong under concurrency in a way that is invisible in
 * development: two submissions for the last remaining slot both read "9 of 10
 * used" and both proceed. The limit then holds only when traffic is light
 * enough not to need it.
 *
 * So the gate is the *post-increment* total. `reserve` adds the amount first,
 * atomically, and reads the resulting number back; whichever caller's write
 * pushed the counter past the ceiling is the caller that loses and has its
 * reservation refunded. Exactly one of two concurrent final-slot requests
 * survives, whatever the interleaving.
 *
 * ── Who is charged for what ─────────────────────────────────────────────────
 *
 * Three different questions, three different meters, and conflating them is how
 * a usage system starts lying:
 *
 *  - `server_operations` / `server_input_bytes` are the **customer** meters:
 *    what the user asked for. Reserved once at admission and settled once per
 *    job. A worker retry is not a second operation — the user submitted one file
 *    — so retries never touch these.
 *  - `compute_units` is the **infrastructure** meter: what the work cost us.
 *    Recorded per *attempt*, because three attempts really do cost three runs.
 *    It is not enforceable (see METERS), so it can never deny anything.
 *  - The event ledger records every attempt individually, with its attempt
 *    number, so a job that succeeded on attempt 2 does not hide attempt 1.
 *
 * ── Fail-open, everywhere ───────────────────────────────────────────────────
 *
 * Every repository and entitlement call is wrapped. A metering outage must never
 * stop someone compressing a PDF: the honest cost of a database hiccup is a
 * missing row in a dashboard, not a user who cannot use the product. Each
 * fail-open path warns and reports `degraded: true` so the gap is visible rather
 * than silently absorbed.
 */

/** Who is consuming. Resolved server-side; never read from a request body. */
export interface UsageActor {
  ownerType: UsageOwnerType;
  ownerId: string;
}

export interface AuthorizeUsageInput {
  actor: UsageActor;
  toolSlug: string;
  /**
   * Null for an unknown or non-executable slug. Treated as "not server-costed"
   * rather than as a refusal: refusing an unknown tool is `createJob`'s job via
   * `assertRemoteJobTool`, and duplicating it here would put the same guard in
   * two places. Nothing is reserved either way.
   */
  executionMode: ToolExecutionMode | null;
  /** Total bytes submitted across every input. */
  inputBytes: number;
  /** Largest single input, for the plan's file-size ceiling. Defaults to inputBytes. */
  largestInputBytes?: number;
  /** Current instant. Passed in so tests and period boundaries are reproducible. */
  at?: Date;
}

/**
 * A held allowance.
 *
 * Carries the period bounds it was taken in, not just the amounts. A job created
 * at 23:59 UTC and settled at 00:01 must refund into *yesterday's* window —
 * refunding into today's would leave yesterday permanently over-counted and
 * today's allowance silently inflated.
 */
export interface UsageReservation {
  actor: UsageActor;
  toolSlug: string;
  amounts: Partial<Record<MeterKey, number>>;
  reservedAt: Date;
}

export interface AuthorizeUsageOutcome {
  /** The truthful verdict, regardless of mode. */
  allowed: boolean;
  /** Whether the caller must actually refuse. False in observe/off mode. */
  blocked: boolean;
  plan: PlanId;
  decision: LimitDecision;
  /** Null when nothing was reserved: a local tool, a block, or a degraded read. */
  reservation: UsageReservation | null;
  /** True when metering could not be consulted and the call was allowed anyway. */
  degraded: boolean;
}

export type ProcessingOutcomeResult = "success" | "failure" | "cancelled";

export interface SettleProcessingOutcomeInput {
  /** The job whose attempt this is. The idempotency subject. */
  jobId: string;
  actor: UsageActor;
  toolSlug: string;
  executionMode: ToolExecutionMode | null;
  result: ProcessingOutcomeResult;
  /** 1 for a first run. Recorded per attempt, never summed into a customer meter. */
  attempt: number;
  /**
   * Whether another attempt is already scheduled.
   *
   * Supplied by the caller rather than re-derived here: the retry decision is
   * `ProcessingJobHandler`'s, made from `isRetryableCategory` plus the attempt
   * budget, and a second copy of that rule in this file could disagree with it.
   */
  willRetry: boolean;
  inputBytes: number | null;
  outputBytes: number | null;
  pageCount: number | null;
  durationMs: number | null;
  errorCategory: JobErrorCategory | null;
  /**
   * The allowance this job is holding, or null when it holds none — a tool that
   * ran without metering, or an admission that failed open. Null means the
   * attempt is still recorded and its compute still charged, but nothing is
   * refunded: crediting back a debit that never happened mints allowance.
   */
  reservation: { reservedAt: Date } | null;
  at?: Date;
}

/** What a settlement actually did, for logging and for tests. */
export interface UsageSettlement {
  /** True when the customer meters were settled by THIS call. */
  settled: boolean;
  /** "kept" on success, "refunded" on a terminal non-success. */
  disposition:
    | "kept"
    | "refunded"
    | "pending_retry"
    | "duplicate"
    | "not_metered"
    | "unreserved";
  /** Compute units charged by this call. Zero when the attempt was a duplicate. */
  costUnits: number;
  degraded: boolean;
}

/** One meter's live state, for the allowance snapshot. */
export interface MeterSnapshot {
  meter: MeterKey;
  unit: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  resetAt: Date;
}

export interface UsageSnapshot {
  plan: PlanId;
  planLabel: string;
  mode: LimitMode;
  maxFileBytes: number;
  maxConcurrentJobs: number;
  activeOperations: number;
  meters: MeterSnapshot[];
  degraded: boolean;
}

export interface UsageMeteringServiceDeps {
  usage: IUsageRepository;
  entitlements: IEntitlementProvider;
  logger: ILogger;
  /**
   * Enforcement mode. **Defaults to observe**, and that default is the point of
   * this phase: the numbers in `PLAN_ENTITLEMENTS` are candidates measured
   * against real traffic, not a paywall. Shipping enforcement before that data
   * exists would block people using limits nobody has validated.
   */
  mode?: LimitMode;
  now?: () => Date;
}

/**
 * How many settled subjects to remember. Bounds memory on a long-lived worker;
 * see the ceiling note on `settled`.
 */
const SETTLEMENT_MEMORY = 5000;

export class UsageMeteringService {
  private readonly usage: IUsageRepository;
  private readonly entitlements: IEntitlementProvider;
  private readonly logger: ILogger;
  private readonly limitMode: LimitMode;
  private readonly now: () => Date;

  /**
   * Attempts already recorded, newest last. Keyed `<jobId>#<attempt>:<result>`.
   *
   * Deliberately NOT durable, unlike the customer settlement. This guards the
   * *infrastructure* half — the attempt event and the compute charge — where two
   * workers double-recording is a small telemetry error about what the work cost
   * us, not a billing error. Paying for a database round trip on every attempt to
   * prevent that would be the wrong trade.
   *
   * Also the fallback substrate when a durable claim is unavailable; see
   * `claimSettlement`.
   *
   * ponytail: bounded to SETTLEMENT_MEMORY entries, FIFO. Fine while an attempt
   * key is only interesting for the seconds around one job finishing.
   */
  private readonly settled = new Set<string>();

  constructor(deps: UsageMeteringServiceDeps) {
    this.usage = deps.usage;
    this.entitlements = deps.entitlements;
    this.logger = deps.logger;
    this.limitMode = deps.mode ?? "observe";
    this.now = deps.now ?? (() => new Date());
  }

  /** The mode in force. Exposed so a route can report it without guessing. */
  get mode(): LimitMode {
    return this.limitMode;
  }

  // ---- admission ---------------------------------------------------------

  /**
   * Resolves the plan, evaluates the limits, and reserves the allowance.
   *
   * Ordering is the contract: plan → counters → policy → reserve. Nothing
   * expensive happens before the reservation is held, and nothing is reserved
   * for a call that is going to be refused.
   */
  async authorize(input: AuthorizeUsageInput): Promise<AuthorizeUsageOutcome> {
    const at = input.at ?? this.now();
    const plan = await this.planFor(input.actor);

    // A tool that runs in the user's browser costs us nothing and is charged
    // nothing. Returning early — rather than reserving zero — means a local tool
    // writes no counter row at all, so "local tools consume zero remote-job
    // quota" is a property of the control flow, not of an amount that happens to
    // be zero today.
    if (!isMetered(input.toolSlug, input.executionMode)) {
      return {
        allowed: true,
        blocked: false,
        plan,
        decision: this.allowDecision(plan, at),
        reservation: null,
        degraded: false,
      };
    }

    const inputBytes = normalizeBytes(input.inputBytes);
    const largest = normalizeBytes(input.largestInputBytes ?? input.inputBytes);
    const amounts: Partial<Record<MeterKey, number>> = {
      server_operations: 1,
      server_input_bytes: inputBytes,
    };

    let counters: Partial<Record<MeterKey, number>>;
    let activeOperations: number;
    try {
      counters = await this.readCounters(input.actor, at);
      activeOperations = await this.usage.countActiveOperations(
        input.actor.ownerType,
        input.actor.ownerId,
      );
    } catch (err) {
      // Fail open. A counter we cannot read is not evidence of an exhausted
      // allowance, and treating it as one would turn a database blip into an
      // outage for every user at once.
      this.warn("Usage counters unreadable; allowing without a reservation", err);
      return {
        allowed: true,
        blocked: false,
        plan,
        decision: this.allowDecision(plan, at),
        reservation: null,
        degraded: true,
      };
    }

    const decision = evaluateLimits({
      plan,
      usage: { counters },
      request: { amounts, largestInputBytes: largest, activeOperations },
      mode: this.limitMode,
      at,
    });

    if (isReportableDenial(decision)) {
      await this.recordLimitEvent(plan, input, decision, at);
    }

    // A refusal that will actually be applied reserves nothing: there is no work
    // to hold an allowance for.
    if (shouldBlock(decision)) {
      return { allowed: false, blocked: true, plan, decision, reservation: null, degraded: false };
    }

    // Observe-mode denials fall through to here deliberately. The work proceeds,
    // so the usage is real and must be counted — otherwise the very traffic the
    // observation exists to measure is the traffic missing from the counters.
    const reserved = await this.reserve(input.actor, input.toolSlug, amounts, plan, at);
    const settledDecision = reserved.decision ?? decision;

    if (reserved.decision) {
      // Lost a race for the last slot. The decision came back already refunded,
      // and `shouldBlock` — not the mode, not `allowed` — decides whether the
      // caller has to act on it.
      await this.recordLimitEvent(plan, input, reserved.decision, at);
    }

    return {
      allowed: settledDecision.allowed,
      blocked: shouldBlock(settledDecision),
      plan,
      decision: settledDecision,
      reservation: reserved.reservation,
      degraded: reserved.degraded,
    };
  }

  /**
   * Returns a held allowance without consuming it.
   *
   * Called when work is abandoned between admission and execution — a staging
   * failure, a queue rejection. Idempotent per reservation object: a caller that
   * releases twice refunds once, because the second call finds the amounts
   * already zeroed.
   */
  async release(reservation: UsageReservation | null): Promise<void> {
    if (!reservation) return;
    const amounts = reservation.amounts;
    if (!hasAmounts(amounts)) return;
    // Zero the object first, so a double release cannot double-refund even if
    // the write below is retried by its caller.
    reservation.amounts = {};
    await this.applyDeltas(reservation.actor, amounts, reservation.reservedAt, -1).catch(
      (err) => {
        this.warn("Usage release failed; the reservation stays consumed", err);
      },
    );
  }

  // ---- settlement --------------------------------------------------------

  /**
   * Records one processing attempt and, at most once per job, settles the
   * customer meters.
   *
   * The three cases, and why each is what it is:
   *
   *  - **Another attempt is coming** (`willRetry`). The attempt is recorded and
   *    its compute is charged, but the customer meters are untouched. The user
   *    submitted one operation; our decision to run it again is our cost, not
   *    theirs.
   *  - **Success.** The reservation is kept — it was already consumed at
   *    admission, so success is precisely the case where nothing further happens
   *    to the customer meters. Charging here as well is the classic double-count.
   *  - **Terminal failure or cancellation.** The reservation is refunded, into
   *    the window it was taken in. A corrupt PDF or a cancelled job gave the user
   *    nothing, and an allowance spent on nothing is a bug they experience as
   *    "the limit is wrong".
   */
  async settleProcessingOutcome(
    input: SettleProcessingOutcomeInput,
  ): Promise<UsageSettlement> {
    const at = input.at ?? this.now();
    const plan = await this.planFor(input.actor);
    const metered = isMetered(input.toolSlug, input.executionMode);

    const attemptKey = `${input.jobId}#${input.attempt}:${input.result}`;
    const duplicateAttempt = this.settled.has(attemptKey);
    const costUnits =
      metered && !duplicateAttempt
        ? measureCostUnits({
            slug: input.toolSlug,
            inputBytes: input.inputBytes,
            pageCount: input.pageCount,
          })
        : 0;

    if (!duplicateAttempt) {
      this.remember(attemptKey);
      await this.recordAttemptEvent(plan, input, costUnits, at);
      if (costUnits > 0) {
        // Per attempt, and never enforceable — this is what the work cost us, and
        // it is the number that makes the estimates in `cost.ts` calibratable.
        await this.applyDeltas(
          input.actor,
          { compute_units: costUnits },
          at,
          1,
        ).catch((err) => this.warn("Compute usage not recorded", err));
      }
    }

    if (!metered) {
      return { settled: false, disposition: "not_metered", costUnits: 0, degraded: false };
    }

    if (input.willRetry) {
      return {
        settled: false,
        disposition: "pending_retry",
        costUnits,
        degraded: false,
      };
    }

    // The customer settlement happens exactly once per JOB, and the claim for it
    // is durable and atomic — see `claimSettlement`. Two workers racing on the
    // same job id contend on one row, so only one of them refunds. Note this is
    // reached only for a run that will NOT be retried: a retryable failure
    // returns above without claiming, so a later attempt can still settle.
    const claim = await this.claimSettlement(input.jobId, at);
    if (!claim.claimed) {
      return { settled: false, disposition: "duplicate", costUnits, degraded: claim.degraded };
    }

    if (input.result === "success") {
      return { settled: true, disposition: "kept", costUnits, degraded: claim.degraded };
    }

    if (!input.reservation) {
      return { settled: true, disposition: "unreserved", costUnits, degraded: claim.degraded };
    }

    // Refund into the reservation's own window, not the current one.
    let degraded = claim.degraded;
    try {
      await this.applyDeltas(
        input.actor,
        {
          server_operations: 1,
          server_input_bytes: normalizeBytes(input.inputBytes ?? 0),
        },
        input.reservation.reservedAt,
        -1,
      );
    } catch (err) {
      degraded = true;
      this.warn("Usage refund failed; the allowance stays consumed", err);
    }
    return { settled: true, disposition: "refunded", costUnits, degraded };
  }

  // ---- reporting ---------------------------------------------------------

  /** Current usage and remaining allowance for one actor. */
  async snapshot(actor: UsageActor, at?: Date): Promise<UsageSnapshot> {
    const when = at ?? this.now();
    const plan = await this.planFor(actor);
    const limits = planLimitsFor(plan);

    let counters: Partial<Record<MeterKey, number>> = {};
    let activeOperations = 0;
    let degraded = false;
    try {
      counters = await this.readCounters(actor, when);
      activeOperations = await this.usage.countActiveOperations(
        actor.ownerType,
        actor.ownerId,
      );
    } catch (err) {
      degraded = true;
      this.warn("Usage snapshot degraded", err);
    }

    return {
      plan,
      planLabel: limits.label,
      mode: this.limitMode,
      maxFileBytes: limits.maxFileBytes,
      maxConcurrentJobs: limits.maxConcurrentJobs,
      activeOperations,
      meters: ENFORCEABLE_METERS.map((meter) => {
        const limit = meterLimitFor(plan, meter);
        const used = Math.max(0, counters[meter] ?? 0);
        return {
          meter,
          unit: METERS[meter].unit,
          used,
          limit,
          remaining: limit === null ? null : Math.max(0, limit - used),
          resetAt: periodBoundsFor(METERS[meter].window, when).end,
        };
      }),
      degraded,
    };
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Takes the allowance, then checks whether taking it went too far.
   *
   * This is the atomic half of admission. `incrementCounters` returns the totals
   * *after* the write, so a caller that pushed a meter past its ceiling can see
   * that it did — which a read-then-compare never can, because the read happened
   * before the other caller's write.
   */
  private async reserve(
    actor: UsageActor,
    toolSlug: string,
    amounts: Partial<Record<MeterKey, number>>,
    plan: PlanId,
    at: Date,
  ): Promise<{
    reservation: UsageReservation | null;
    decision: LimitDecision | null;
    degraded: boolean;
  }> {
    let readings;
    try {
      readings = await this.applyDeltas(actor, amounts, at, 1);
    } catch (err) {
      // Fail open again: an unreservable counter allows the work through
      // unmetered rather than refusing it.
      this.warn("Usage reservation failed; allowing unmetered", err);
      return { reservation: null, decision: null, degraded: true };
    }

    const reservation: UsageReservation = {
      actor,
      toolSlug,
      amounts: { ...amounts },
      reservedAt: at,
    };

    // Re-run the SAME policy against the post-increment totals. Feeding it
    // `total - requested` as the prior usage makes its `used + requested > limit`
    // test reduce to `total > limit`, which is exactly the question a winner of
    // the race answers "no" to and a loser answers "yes" to. Re-deriving that
    // comparison here instead would be a second limit rule that can drift from
    // the tested one.
    const priorCounters: Partial<Record<MeterKey, number>> = {};
    for (const reading of readings) {
      priorCounters[reading.meter] = reading.amount - (amounts[reading.meter] ?? 0);
    }
    const decision = evaluateLimits({
      plan,
      usage: { counters: priorCounters },
      // Size and concurrency were already cleared pre-flight and are not what
      // this second pass is asking about.
      request: { amounts, largestInputBytes: 0, activeOperations: 0 },
      mode: this.limitMode,
      at,
    });

    // Only a decision that will actually be applied refunds. In observe mode the
    // work proceeds, so the count has to stand — the over-limit traffic is the
    // very thing the observation exists to measure.
    if (shouldBlock(decision)) {
      await this.release(reservation);
      return { reservation: null, decision, degraded: false };
    }

    return { reservation, decision: null, degraded: false };
  }

  /** Applies signed increments, one counter row per meter, in its own window. */
  private async applyDeltas(
    actor: UsageActor,
    amounts: Partial<Record<MeterKey, number>>,
    at: Date,
    sign: 1 | -1,
  ) {
    const increments: CounterIncrement[] = [];
    for (const [meter, amount] of Object.entries(amounts) as [MeterKey, number][]) {
      if (!amount || amount <= 0) continue;
      const bounds = periodBoundsFor(METERS[meter].window, at);
      increments.push({ ...this.scope(actor, meter, bounds), delta: sign * Math.trunc(amount) });
    }
    if (increments.length === 0) return [];
    return this.usage.incrementCounters(increments);
  }

  private async readCounters(
    actor: UsageActor,
    at: Date,
  ): Promise<Partial<Record<MeterKey, number>>> {
    const scopes: CounterScope[] = ENFORCEABLE_METERS.map((meter) =>
      this.scope(actor, meter, periodBoundsFor(METERS[meter].window, at)),
    );
    const readings = await this.usage.readCounters(scopes);
    const out: Partial<Record<MeterKey, number>> = {};
    for (const reading of readings) out[reading.meter] = reading.amount;
    return out;
  }

  private scope(actor: UsageActor, meter: MeterKey, bounds: PeriodBounds): CounterScope {
    return {
      ownerType: actor.ownerType,
      ownerId: actor.ownerId,
      meter,
      periodStart: bounds.start,
      periodEnd: bounds.end,
    };
  }

  /** Plan lookup that cannot throw. An unresolvable plan is the least generous one. */
  private async planFor(actor: UsageActor): Promise<PlanId> {
    try {
      return await this.entitlements.planFor(actor);
    } catch (err) {
      this.warn("Plan lookup failed; treating the caller as free", err);
      return DEFAULT_PLAN_ID;
    }
  }

  /**
   * A decision object for a path that was never evaluated (a local tool, a
   * degraded read). Shaped like a real allow so callers have one type to handle.
   */
  private allowDecision(plan: PlanId, at: Date): LimitDecision {
    return evaluateLimits({
      plan,
      usage: { counters: {} },
      request: { amounts: {}, largestInputBytes: 0, activeOperations: 0 },
      mode: this.limitMode,
      at,
    });
  }

  /**
   * The ledger row for one attempt.
   *
   * What is NOT here is the guarantee: no filename, no storage key, no options,
   * no error text, no owner id. `UsageEventRecord` has no field for an owner, so
   * the anonymity is enforced by the type rather than by this method's care.
   */
  private async recordAttemptEvent(
    plan: PlanId,
    input: SettleProcessingOutcomeInput,
    costUnits: number,
    at: Date,
  ): Promise<void> {
    const record: UsageEventRecord = {
      eventName: ANALYTICS_EVENTS.tool_processing_completed,
      occurredAt: at,
      ownerType: input.actor.ownerType,
      planId: plan,
      toolSlug: input.toolSlug,
      executionMode: input.executionMode,
      result: input.result,
      errorCategory: input.errorCategory,
      attempt: input.attempt,
      inputBytes: input.inputBytes,
      outputBytes: input.outputBytes,
      inputSizeBucket: sizeBucket(input.inputBytes),
      pageCount: input.pageCount,
      durationMs: input.durationMs,
      costUnits,
    };
    await this.usage.recordEvent(record).catch((err) => {
      this.warn("Usage event not recorded", err);
    });
  }

  /**
   * Records a denial — including one that observe mode did not apply.
   *
   * The would-have-denied rows are the entire reason this phase runs in observe
   * mode: they are the dataset that says where a candidate ceiling would have
   * bitten and whom it would have hit, which is the only honest way to pick one.
   */
  private async recordLimitEvent(
    plan: PlanId,
    input: AuthorizeUsageInput,
    decision: LimitDecision,
    at: Date,
  ): Promise<void> {
    await this.usage
      .recordEvent({
        eventName: ANALYTICS_EVENTS.limit_reached,
        occurredAt: at,
        ownerType: input.actor.ownerType,
        planId: plan,
        toolSlug: input.toolSlug,
        executionMode: input.executionMode,
        inputBytes: normalizeBytes(input.inputBytes),
        inputSizeBucket: sizeBucket(input.inputBytes),
        // Through the taxonomy, not straight into the row: the repository's
        // contract is that properties arrive already sanitized, and routing this
        // one call site around the allowlist is how that stops being true.
        properties: sanitizeEventProperties(ANALYTICS_EVENTS.limit_reached, {
          reason: decision.reason ?? "unknown",
          meter: decision.meter ?? "none",
          enforced: decision.enforced,
          limit: decision.limit ?? -1,
          used: decision.used,
          plan,
          toolSlug: input.toolSlug,
          executionMode: input.executionMode,
          ownerType: input.actor.ownerType,
        }),
      })
      .catch((err) => this.warn("Limit event not recorded", err));
  }

  /**
   * Claims the once-per-job customer settlement.
   *
   * The repository is the authority: a unique key insert, so two processes cannot
   * both win. When that store is unreachable the claim is *unknown*, and the two
   * available answers are both wrong in different directions — "not claimed"
   * double-refunds, "claimed" silently drops a refund. Falling back to the
   * in-process set keeps the behaviour this service had before the durable marker
   * existed rather than choosing a new way to be wrong, and `degraded` says so
   * out loud so a caller and a dashboard can tell the difference.
   */
  private async claimSettlement(
    key: string,
    at: Date,
  ): Promise<{ claimed: boolean; degraded: boolean }> {
    try {
      return { claimed: await this.usage.claimSettlement(key, at), degraded: false };
    } catch (err) {
      this.warn("Durable settlement claim unavailable; using in-process guard", err);
      if (this.settled.has(key)) return { claimed: false, degraded: true };
      this.remember(key);
      return { claimed: true, degraded: true };
    }
  }

  private remember(key: string): void {
    if (this.settled.size >= SETTLEMENT_MEMORY) {
      // Drop the oldest. Set preserves insertion order, so this is FIFO.
      const oldest = this.settled.values().next();
      if (!oldest.done) this.settled.delete(oldest.value);
    }
    this.settled.add(key);
  }

  private warn(message: string, err: unknown): void {
    this.logger.warn(message, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Non-negative whole bytes. Guards a float or a NaN reaching an Int column. */
function normalizeBytes(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** `isServerCosted`, tolerating the null mode an unknown slug resolves to. */
function isMetered(slug: string, mode: ToolExecutionMode | null): boolean {
  return mode !== null && isServerCosted(slug, mode);
}

function hasAmounts(amounts: Partial<Record<MeterKey, number>>): boolean {
  return Object.values(amounts).some((v) => typeof v === "number" && v > 0);
}

/**
 * Reads the enforcement mode from the environment.
 *
 * Defaults to `observe`, and an unrecognized value also resolves to `observe`
 * rather than to `enforce` — a typo in a deploy variable must not be the thing
 * that starts refusing customer traffic. Mirrors how `processingPilot.ts` reads
 * its own override.
 */
export function resolveLimitMode(raw: string | undefined | null): LimitMode {
  const value = (raw ?? "").trim().toLowerCase();
  return isLimitMode(value) ? value : "observe";
}

/**
 * Thrown when an enforced limit refuses work.
 *
 * Carries the safe user-facing message and the reset delay the policy computed,
 * so the route maps it to a 429 without re-deriving either. Only ever
 * constructed from a decision where `shouldBlock` was true — an observe-mode
 * denial must not be able to produce one of these.
 */
export class UsageLimitError extends Error {
  readonly name = "UsageLimitError";
  readonly reason: string;
  readonly meter: string | null;
  readonly limit: number | null;
  readonly used: number;
  readonly retryAfterSeconds: number | null;
  readonly plan: PlanId;

  constructor(decision: LimitDecision) {
    super(decision.message ?? "Usage limit reached.");
    this.reason = decision.reason ?? "unknown";
    this.meter = decision.meter;
    this.limit = decision.limit;
    this.used = decision.used;
    this.retryAfterSeconds = decision.retryAfterSeconds;
    this.plan = decision.plan;
  }
}
