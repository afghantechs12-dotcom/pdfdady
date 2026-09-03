import { SectionHeader } from "@/components/admin/Section";
import { AnalyticsDashboard } from "@/components/admin/AnalyticsDashboard";

export const metadata = { title: { absolute: "Analytics — PDFDadi Admin" } };

/**
 * Processing analytics.
 *
 * The page itself reads nothing. The report is fetched client-side from
 * `/api/admin/analytics`, which keeps the window switch and the refresh button
 * working without a round trip through a server component, and keeps the admin
 * guard in exactly one place — the API route — rather than duplicated between a
 * page loader and an endpoint that could drift apart.
 */
export default function AdminAnalyticsPage() {
  return (
    <>
      <SectionHeader
        eyebrow="Analytics"
        title="Processing analytics"
        description="Server and in-browser tool activity from the usage ledger. Aggregated on the server: individual events never leave it, and the ledger holds no user identity to begin with."
      />
      <AnalyticsDashboard />
    </>
  );
}
