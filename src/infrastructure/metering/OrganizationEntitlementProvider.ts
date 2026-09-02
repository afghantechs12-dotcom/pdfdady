import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IBillingRepository } from "@/src/application/ports/billing/BillingRepository";
import { entitledPlanFor } from "@/src/domain/billing/subscription";
import type { ILogger } from "@/src/application/ports/Logger";
import type {
  EntitlementSubject,
  IEntitlementProvider,
} from "@/src/application/ports/metering/EntitlementProvider";
import {
  DEFAULT_PLAN_ID,
  GUEST_PLAN_ID,
  isPlanId,
  toPlanId,
  type PlanId,
} from "@/src/domain/metering/plans";

/**
 * Resolves a caller's plan from organization membership and billing state.
 *
 * Resolution rules, in order:
 *
 *  - An anonymous visitor is `guest`. There is no org to consult and no account
 *    to attribute allowance to.
 *  - A signed-in user takes the *best* plan among their organizations. Someone
 *    who belongs to a Business org and also to a personal free org should not
 *    lose their paid entitlements because of membership ordering.
 *  - Anything unresolvable — no memberships, an unreadable database, a thrown
 *    provider — is `free`. Fail-safe here means the least generous *account*
 *    plan, not zero access: a signed-in user whose org lookup fails should still
 *    be able to work, just not at Pro allowances.
 *
 * ── How a subscription and `Organization.plan` coexist ──────────────────────
 *
 * Per organization, exactly one of two sources decides, and which one is chosen
 * by *existence*, not by generosity:
 *
 *  - **A billing row exists** → `entitledPlanFor` is authoritative and
 *    `Organization.plan` is ignored entirely. This is the rule that makes
 *    cancellation actually work. Taking the best of the two instead would let a
 *    stale `plan = "pro"` — set by an admin, or left behind by an earlier manual
 *    grant — keep Pro alive for ever after the subscription ended, which is the
 *    single most expensive way to get this wrong.
 *  - **No billing row** → `toPlanId(org.plan)`, exactly as before. Organizations
 *    that predate billing, internal accounts and manually-granted plans keep
 *    working with no backfill, and no migration has to guess which of them were
 *    "really" paying.
 *
 * The consequence worth stating: opening checkout creates a billing row (with the
 * customer, `status: "incomplete"`, `planId: "free"`), so from that moment the
 * subscription is what counts for that org. An org whose plan was hand-set to
 * `pro` and which then starts a real checkout drops to free until the payment
 * lands. That is the correct direction to fail, and it is why the manual-grant
 * path is "no row" rather than "row with a plan".
 *
 * `billing` is optional so the provider still constructs — and behaves exactly as
 * it did before billing existed — in a deployment or test with no billing wiring.
 */
export class OrganizationEntitlementProvider implements IEntitlementProvider {
  constructor(
    private readonly organizations: IOrganizationProvider,
    private readonly logger: ILogger,
    private readonly billing: IBillingRepository | null = null,
  ) {}

  async planFor(subject: EntitlementSubject): Promise<PlanId> {
    if (subject.ownerType !== "user") return GUEST_PLAN_ID;

    try {
      const orgs = await this.organizations.listForUser(subject.ownerId);
      const now = new Date();
      let best: PlanId = DEFAULT_PLAN_ID;
      for (const org of orgs) {
        const plan = await this.planForOrganization(org.id, org.plan, now);
        if (PLAN_RANK[plan] > PLAN_RANK[best]) best = plan;
      }
      return best;
    } catch (err) {
      // Never fatal. A metering lookup failing must not stop someone using the
      // product; it only means they are treated as free until it recovers.
      this.logger.warn("Entitlement lookup failed; defaulting to the free plan", {
        error: err instanceof Error ? err.message : String(err),
      });
      return DEFAULT_PLAN_ID;
    }
  }

  /**
   * One organization's plan: subscription if it has billing state, legacy column
   * otherwise.
   *
   * A billing lookup that *throws* is not treated as "no row" — that would fall
   * back to `Organization.plan` and could resurrect a stale paid grant on a
   * database hiccup. It propagates to the caller's catch, which resolves to
   * `free`: the least generous account plan, which is the safe answer to "we
   * cannot tell".
   *
   * ponytail: one query per organization. Almost every user has exactly one, so
   * this is 1 extra read on the metering path; if a many-org account shows up in
   * traces, add a `findMany({ where: { organizationId: { in: ids } } })` to the
   * repository and batch it here.
   */
  private async planForOrganization(
    organizationId: string,
    legacyPlan: string,
    now: Date,
  ): Promise<PlanId> {
    if (!this.billing) return toPlanId(legacyPlan);
    const record = await this.billing.getByOrganization(organizationId);
    if (!record) return toPlanId(legacyPlan);
    return entitledPlanFor(record, now);
  }
}

/**
 * Generosity ordering, used only to pick the best of several memberships.
 *
 * Kept here rather than in the domain because it is a property of *this*
 * resolution strategy: a user is one actor but can belong to several
 * organizations, each with its own subscription, and metering charges the actor.
 * Ranking is how one plan is chosen for them without membership order deciding it.
 */
const PLAN_RANK: Record<PlanId, number> = {
  guest: 0,
  free: 1,
  pro: 2,
  business: 3,
};

/** A fixed-plan provider, for tests and for local development. */
export class StaticEntitlementProvider implements IEntitlementProvider {
  constructor(private readonly plan: PlanId = DEFAULT_PLAN_ID) {}

  async planFor(subject: EntitlementSubject): Promise<PlanId> {
    if (subject.ownerType !== "user") return GUEST_PLAN_ID;
    return isPlanId(this.plan) ? this.plan : DEFAULT_PLAN_ID;
  }
}
