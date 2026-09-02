import { createHash, createHmac } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type {
  IUsageRepository,
  UsageEventRecord,
  UsageOwnerType,
} from "@/src/application/ports/metering/UsageRepository";
import type { IEntitlementProvider } from "@/src/application/ports/metering/EntitlementProvider";
import {
  ANALYTICS_EVENTS,
  isClientIngestibleEvent,
  sanitizeEventProperties,
  type AnalyticsEventName,
} from "@/src/domain/metering/events";
import { isLocalToolErrorCategory } from "@/src/domain/jobs/jobErrors";
import { periodKeyFor } from "@/src/domain/metering/periods";
import { DEFAULT_PLAN_ID, GUEST_PLAN_ID, type PlanId } from "@/src/domain/metering/plans";

/**
 * Client product analytics ingest. The only path a browser event takes into the
 * ledger.
 *
 * ── Why the browser is not trusted with anything but the event ───────────────
 *
 * A client tells us one thing honestly: what the person did in the tab. It
 * cannot be trusted with who they are, what plan they are on, or which of the
 * server-authoritative events happened — `tool_processing_completed` and
 * `limit_reached` are what the worker and the admission check *observed*, and a
 * client that could post them could write any number it liked into the dataset
 * the dashboards read, with no way afterwards to separate injected rows from
 * measured ones. So the split is: the client names the event and its declared
 * dimensions; the server supplies identity, actor class, and plan.
 *
 * `ownerId` is not merely ignored if sent — `UsageEventRecord` has no field for
 * one, so there is nowhere for it to land even by mistake. What identity the
 * ledger does carry is `subjectHash`, and only that.
 *
 * ── Why quota counters are untouchable from here ────────────────────────────
 *
 * This class calls `recordEvents` and nothing else on the repository. It has no
 * code path to `incrementCounters`, deliberately: quota is what may refuse a
 * user's work, and a beacon anyone can POST from a console must not be able to
 * move it. A `fetch` loop against this endpoint costs the attacker rate-limit
 * budget and gains them nothing that can deny anyone service.
 *
 * ── Why nothing here throws ────────────────────────────────────────────────
 *
 * Same rule as `ProcessingUsageRecorder` and `UsageMeteringService`: analytics
 * is never allowed to fail the thing it is measuring. Merge PDF runs entirely in
 * the user's browser — an ingest that 500s must be invisible to it. Every
 * failure path warns and returns a count.
 */

/** Resolved server-side. Never read from a request body. */
export interface AnalyticsActor {
  ownerType: UsageOwnerType;
  ownerId: string;
}

/** One event as it arrives from a browser, before any of it is believed. */
export interface ClientAnalyticsEvent {
  name: string;
  properties?: Record<string, unknown>;
  /** Client timestamp in ms. Clamped to the server window; see `occurredAtFor`. */
  at?: number;
}

export interface IngestAnalyticsInput {
  actor: AnalyticsActor;
  events: readonly ClientAnalyticsEvent[];
  at?: Date;
}

export interface IngestAnalyticsResult {
  /** Events written to the ledger. */
  accepted: number;
  /** Events dropped: unknown name, not client-ingestible, or unusable shape. */
  dropped: number;
  /** True when the write failed and the batch was lost. Never a caller's problem. */
  degraded: boolean;
}

/**
 * Most events one request may carry.
 *
 * The client helper batches a funnel, which is six events; a request asking to
 * write two hundred is not a funnel, it is either a bug looping or someone
 * filling the table. The excess is dropped rather than 400'd — a buggy client
 * that gets an error retries, and a retry loop is the thing this cap exists to
 * stop.
 */
export const MAX_EVENTS_PER_BATCH = 20;

/**
 * How far a client-supplied timestamp may sit behind the server's clock.
 *
 * Client clocks are wrong, sometimes by years, and a wrong one lands rows
 * outside every dashboard window — which reads as "the funnel is empty", not as
 * "one visitor's clock is off". Five minutes covers a queued beacon and a page
 * that was backgrounded; anything further out is replaced by the server's now.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ProductAnalyticsServiceDeps {
  usage: IUsageRepository;
  entitlements: IEntitlementProvider;
  logger: ILogger;
  /**
   * Secret the daily subject salt is derived from. Absent means subject hashing
   * is OFF — `subjectHash` stays null and events are recorded without any funnel
   * identity, which loses per-visitor stitching and keeps the data.
   *
   * Not defaulted to a constant: a hardcoded fallback salt is a salt that is the
   * same in every deployment and therefore not a salt.
   */
  subjectSecret?: string | null;
  now?: () => Date;
}

export class ProductAnalyticsService {
  private readonly usage: IUsageRepository;
  private readonly entitlements: IEntitlementProvider;
  private readonly logger: ILogger;
  private readonly subjectSecret: string | null;
  private readonly now: () => Date;

  constructor(deps: ProductAnalyticsServiceDeps) {
    this.usage = deps.usage;
    this.entitlements = deps.entitlements;
    this.logger = deps.logger;
    const secret = (deps.subjectSecret ?? "").trim();
    this.subjectSecret = secret.length > 0 ? secret : null;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Validates, sanitizes, and appends a batch.
   *
   * The order is the contract: drop by name, then sanitize properties, then
   * attach server-resolved dimensions. Attaching first would let a client
   * property named `plan` or `ownerType` overwrite the resolved one, which is
   * precisely the identity claim the allowlist is not there to catch — the
   * allowlist admits those keys, because the *server* is allowed to set them.
   */
  async ingest(input: IngestAnalyticsInput): Promise<IngestAnalyticsResult> {
    const at = input.at ?? this.now();
    const batch = input.events.slice(0, MAX_EVENTS_PER_BATCH);
    let dropped = input.events.length - batch.length;

    const accepted: { name: AnalyticsEventName; event: ClientAnalyticsEvent }[] = [];
    for (const event of batch) {
      if (typeof event?.name !== "string" || !isClientIngestibleEvent(event.name)) {
        dropped += 1;
        continue;
      }
      accepted.push({ name: event.name, event });
    }

    if (accepted.length === 0) return { accepted: 0, dropped, degraded: false };

    // One lookup per batch, not per event: the plan cannot change mid-batch, and
    // a per-event lookup would make a six-event funnel six database reads.
    const plan = await this.planFor(input.actor);
    const subjectHash = this.subjectHashFor(input.actor, at);

    const records: UsageEventRecord[] = accepted.map(({ name, event }) => {
      const properties = sanitizeEventProperties(name, event.properties);
      return {
        eventName: name,
        occurredAt: occurredAtFor(event.at, at),
        // Server-resolved, and written AFTER sanitization so a client-sent
        // `ownerType: "system"` or `plan: "business"` cannot survive into the row.
        ownerType: input.actor.ownerType,
        planId: plan,
        subjectHash,
        toolSlug: stringProperty(event.properties, "toolSlug"),
        executionMode: stringProperty(event.properties, "executionMode"),
        errorCategory: localCategoryColumn(name, properties),
        properties: {
          ...properties,
          plan,
          ownerType: input.actor.ownerType,
        },
      };
    });

    try {
      await this.usage.recordEvents(records);
    } catch (err) {
      // The batch is lost and the caller is told nothing but "204". A dropped
      // funnel row costs a dashboard a data point; a thrown one would cost a
      // user their merge.
      this.warn("Client analytics batch not recorded", err);
      return { accepted: 0, dropped: dropped + records.length, degraded: true };
    }

    return { accepted: records.length, dropped, degraded: false };
  }

  /**
   * The pseudonymous funnel identity: a non-reversible, daily-rotating digest of
   * the actor, per the `subjectHash` contract on `UsageEventRecord`.
   *
   * Two properties make it a pseudonym rather than an identifier in disguise:
   *
   *  - **Keyed, not plain.** A bare `sha256(ownerId)` is reversible for any id
   *    space you can enumerate, and both of ours are: user ids come out of the
   *    users table, anonymous ids are UUIDv4 minted by us. HMAC under a secret
   *    the ledger's reader does not hold removes that.
   *  - **Rotated daily.** The salt includes the UTC day key, so today's hash for
   *    a visitor differs from tomorrow's. That bounds stitching to within a day
   *    — enough to see a funnel, not enough to build a visitor history — and it
   *    means yesterday's rows cannot be re-linked even by someone who later
   *    learns the secret and an id.
   */
  private subjectHashFor(actor: AnalyticsActor, at: Date): string | null {
    if (!this.subjectSecret) return null;
    const salt = createHmac("sha256", this.subjectSecret)
      .update(`subject:${periodKeyFor("day", at)}`)
      .digest();
    return createHash("sha256")
      .update(salt)
      .update(`${actor.ownerType}:${actor.ownerId}`)
      .digest("hex")
      .slice(0, 32);
  }

  /** Plan lookup that cannot throw. Mirrors UsageMeteringService.planFor. */
  private async planFor(actor: AnalyticsActor): Promise<PlanId> {
    try {
      return await this.entitlements.planFor(actor);
    } catch (err) {
      this.warn("Plan lookup failed for an analytics batch", err);
      return actor.ownerType === "user" ? DEFAULT_PLAN_ID : GUEST_PLAN_ID;
    }
  }

  private warn(message: string, err: unknown): void {
    this.logger.warn(message, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The instant to file an event under: the client's, when it is plausible.
 *
 * A client timestamp is worth keeping — it is the only thing that preserves the
 * order of events a batched beacon delivers in one request — but only within
 * `MAX_CLOCK_SKEW_MS` of the server's clock, and never in the future. A future
 * timestamp is the more damaging direction: it survives every "up to now" window
 * forever and quietly inflates the current day.
 */
export function occurredAtFor(clientMs: number | undefined, serverNow: Date): Date {
  if (typeof clientMs !== "number" || !Number.isFinite(clientMs)) return serverNow;
  const delta = serverNow.getTime() - clientMs;
  if (delta < 0 || delta > MAX_CLOCK_SKEW_MS) return serverNow;
  return new Date(clientMs);
}

/**
 * The `errorCategory` COLUMN for an in-browser failure.
 *
 * The category has to reach the column and not only the `properties` blob. The
 * admin category breakdown is a `groupBy` on the column — `dimensionCounts(...,
 * "errorCategory", [job_failed])` — so a value that lands only in JSON is
 * collected, sanitized, stored, and then counted as a failure nobody classified.
 * That was true of every local failure the browser ever reported: the taxonomy
 * worked, the beacon worked, and the dashboard showed an empty category list next
 * to a non-zero "unclassified" count.
 *
 * Validated against the closed local union rather than trusted as a string.
 * `job_failed` is client-ingestible, so this is a wire boundary: an arbitrary
 * `errorCategory` would otherwise become a label on an admin dashboard. An
 * unrecognised value is dropped to null, which counts as unclassified — the
 * honest bucket for a failure we cannot name. Only `job_failed` populates it;
 * the server-authoritative event that also declares the dimension is written by
 * the worker, not from here.
 */
function localCategoryColumn(
  name: AnalyticsEventName,
  properties: Record<string, string | number | boolean>,
): string | null {
  if (name !== ANALYTICS_EVENTS.job_failed) return null;
  const value = properties.errorCategory;
  return isLocalToolErrorCategory(value) ? value : null;
}

/**
 * Reads one declared dimension for its own indexed column.
 *
 * `toolSlug` and `executionMode` are columns on `usage_events` because every
 * dashboard groups by them; the same values also stay in `properties`. Length is
 * clamped because these bypass `sanitizeEventProperties` on their way to a
 * column — its cap protects the JSON blob, not this path.
 */
function stringProperty(
  properties: Record<string, unknown> | undefined,
  key: "toolSlug" | "executionMode",
): string | null {
  const value = properties?.[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, 120) : null;
}
