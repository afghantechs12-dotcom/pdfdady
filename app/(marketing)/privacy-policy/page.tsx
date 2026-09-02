import type { Metadata } from "next";
import { PageContainer } from "@/components/layout/PageContainer";
import { AdminPageBody } from "@/components/pages/AdminPageBody";
import { getPage } from "@/lib/seo/adminRuntime";
import { buildMetadata } from "@/lib/seo/metadata";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "Privacy Policy",
    description:
      "How PDFDadi handles your data. Files are processed in your browser and are not uploaded or stored for supported tools.",
    path: "/privacy-policy",
  });
}

export default async function PrivacyPolicyPage() {
  const admin = await getPage("privacy");
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
        Privacy Policy
      </h1>
      <p className="mt-3 text-sm text-navy-soft">Last updated at launch.</p>

      <div className="prose-section mt-8 space-y-8 text-navy-soft">
        <section>
          <h2 className="text-xl font-bold text-navy">Browser-based processing</h2>
          <p className="mt-2 leading-relaxed">
            For our supported tools — Merge, Split, Edit and JPG to PDF — your
            files are processed entirely within your browser. They are never
            uploaded to our servers.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">No permanent storage</h2>
          <p className="mt-2 leading-relaxed">
            We do not store your documents. Once you close or refresh the page,
            any file you were working with is gone. We keep no copies.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">Future server tools</h2>
          <p className="mt-2 leading-relaxed">
            Some advanced tools (such as compression, conversion and OCR) will
            require server processing in a future version. When those launch,
            any uploaded file will be processed and then deleted automatically,
            and we&apos;ll update this policy with the details.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-navy">No account required</h2>
          <p className="mt-2 leading-relaxed">
            You can use PDFDadi without creating an account or providing
            personal information.
          </p>
        </section>
      </div>
    </PageContainer>
  );
}
