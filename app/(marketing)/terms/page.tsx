import type { Metadata } from "next";
import { PageContainer } from "@/components/layout/PageContainer";
import { AdminPageBody } from "@/components/pages/AdminPageBody";
import { getPage } from "@/lib/seo/adminRuntime";
import { buildMetadata } from "@/lib/seo/metadata";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "Terms",
    description: "The terms of service for using PDFDadi tools.",
    path: "/terms",
  });
}

export default async function TermsPage() {
  const admin = await getPage("terms");
  if (admin) {
    return (
      <PageContainer className="section-pad" maxWidth="narrow">
        <AdminPageBody content={admin} />
      </PageContainer>
    );
  }
  return (
    <PageContainer className="section-pad" maxWidth="narrow">
      <h1 className="text-[clamp(2rem,4vw,3rem)] font-bold text-navy">
        Terms of Service
      </h1>
      <p className="mt-3 text-sm text-navy-soft">Last updated at launch.</p>

      <div className="mt-8 space-y-8 text-navy-soft">
        <section>
          <h2 className="text-xl font-bold text-navy">Acceptable use</h2>
          <p className="mt-2 leading-relaxed">
            You may only process files that you own or have explicit permission
            to modify. You are responsible for the documents you work with.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">Prohibited activity</h2>
          <p className="mt-2 leading-relaxed">
            You must not use PDFDadi for any illegal, harmful, or abusive
            purpose, or to process content you do not have the right to use.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">No warranty</h2>
          <p className="mt-2 leading-relaxed">
            PDFDadi is provided &quot;as is&quot; without warranties of any
            kind. While we work hard to keep tools reliable, we can&apos;t
            guarantee they will be error-free or suitable for every document.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">Changes</h2>
          <p className="mt-2 leading-relaxed">
            We may update these terms as the product evolves. Continued use
            after changes means you accept the updated terms.
          </p>
        </section>
      </div>
    </PageContainer>
  );
}
