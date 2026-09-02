import { SectionHeader } from "@/components/admin/Section";
import { PricingManager } from "@/components/admin/PricingManager";
import { getPricingPlans } from "@/data/admin";

export const metadata = { title: "Pricing — PDFDadi Admin" };

export default async function AdminPricingPage() {
  const plans = await getPricingPlans();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Pricing plans"
        description="Each plan shows price, period, a short description and a feature checklist. Highlighted gets the gradient border on the public page."
      />
      <PricingManager initial={plans} />
    </>
  );
}
