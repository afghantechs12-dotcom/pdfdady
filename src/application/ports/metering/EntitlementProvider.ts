import type { PlanId } from "@/src/domain/metering/plans";
import type { UsageOwnerType } from "@/src/application/ports/metering/UsageRepository";

/** The minimum an entitlement lookup needs to know about the caller. */
export interface EntitlementSubject {
  ownerType: UsageOwnerType;
  ownerId: string;
}

/**
 * Resolves which plan a caller is on.
 *
 * Behind a port because this is the seam billing will replace. Today it reads
 * `Organization.plan`, a free-text column; when subscriptions exist it will read
 * a subscription instead — and no policy code changes, because policy consumes a
 * `PlanId`, not a database row.
 *
 * Implementations must resolve an unknown or unreadable plan to the *least*
 * generous applicable default (`free` for a user, `guest` for an anonymous
 * visitor), never to the most generous. Getting this backwards would mean a
 * database hiccup silently hands everyone Business entitlements.
 */
export interface IEntitlementProvider {
  planFor(subject: EntitlementSubject): Promise<PlanId>;
}
