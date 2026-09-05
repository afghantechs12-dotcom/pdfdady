import type { PricingPlan } from "@/data/pricing";

/** Preserve each successful snapshot; a later failure leaves the rest dirty. */
export async function persistPricingPlans(plans: readonly PricingPlan[], io: {
  save: (id: string, snapshot: string) => Promise<{ ok: boolean }>;
  onSaved: (id: string, snapshot: string) => void;
}) {
  const snapshots = plans.map(plan => ({ id: plan.id, name: plan.name, snapshot: JSON.stringify(plan) }));
  for (const item of snapshots) {
    const result = await io.save(item.id, item.snapshot);
    if (!result.ok) throw new Error(`Could not save ${item.name}. Your changes are still here.`);
    io.onSaved(item.id, item.snapshot);
  }
}
